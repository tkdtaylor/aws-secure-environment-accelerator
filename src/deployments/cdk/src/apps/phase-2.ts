import { pascalCase } from 'pascal-case';
import * as cfn from '@aws-cdk/aws-cloudformation';
import { getAccountId } from '../utils/accounts';
import { JsonOutputValue } from '../common/json-output';
import { getVpcConfig } from '../common/get-all-vpcs';
import { VpcOutputFinder } from '@aws-accelerator/common-outputs/src/vpc';
import * as ec2 from '@aws-cdk/aws-ec2';
import { PeeringConnectionConfig, VpcConfigType } from '@aws-accelerator/common-config/src';
import { getVpcSharedAccountKeys } from '../common/vpc-subnet-sharing';
import { SecurityGroup } from '../common/security-group';
import { AddTagsToResourcesOutput } from '../common/add-tags-to-resources-output';
import * as firewallManagement from '../deployments/firewall/manager';
import * as firewallCluster from '../deployments/firewall/cluster';
import * as securityHub from '../deployments/security-hub';
import { createRoleName } from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
import { CentralBucketOutput, AccountBucketOutput } from '../deployments/defaults';
import { PcxOutput, PcxOutputType } from '../deployments/vpc-peering/outputs';
import { StructuredOutput } from '../common/structured-output';
import { PhaseInput } from './shared';
import * as madDeployment from '../deployments/mad';
import * as vpcDeployment from '../deployments/vpc';
import * as createTrail from '../deployments/cloud-trail';
import * as tgwDeployment from '../deployments/transit-gateway';
import * as macie from '../deployments/macie';
import * as centralServices from '../deployments/central-services';
import * as guardDutyDeployment from '../deployments/guardduty';

/**
 * This is the main entry point to deploy phase 2.
 *
 * The following resources are deployed in phase 2:
 *   - Creates Peering Connection
 */

export async function deploy({ acceleratorConfig, accountStacks, accounts, context, outputs }: PhaseInput) {
  const securityAccountKey = acceleratorConfig.getMandatoryAccountKey('central-security');

  // Find the account buckets in the outputs
  const accountBuckets = AccountBucketOutput.getAccountBuckets({
    accounts,
    accountStacks,
    config: acceleratorConfig,
    outputs,
  });

  if (!acceleratorConfig['global-options']['alz-baseline']) {
    await createTrail.step1({
      accountBuckets,
      accountStacks,
      config: acceleratorConfig,
      outputs,
      context,
    });
  }

  /**
   * Code to create Peering Connection in all accounts
   */

  const vpcConfigs = acceleratorConfig.getVpcConfigs();
  for (const { accountKey, vpcConfig } of vpcConfigs) {
    const pcxConfig = vpcConfig.pcx;
    if (!PeeringConnectionConfig.is(pcxConfig)) {
      continue;
    }

    const accountStack = accountStacks.tryGetOrCreateAccountStack(accountKey, vpcConfig.region);
    if (!accountStack) {
      console.warn(`Cannot find account stack ${accountKey}`);
      continue;
    }

    // TODO store role name in outputs
    // Get the exact same role name as in phase 1
    const roleName = createRoleName(`VPC-PCX-${pascalCase(accountKey)}To${pascalCase(pcxConfig.source)}`, 0);
    const peerRoleArn = `arn:aws:iam::${getAccountId(accounts, pcxConfig.source)}:role/${roleName}`;

    // Get Peer VPC Configuration
    const pcxSourceVpc = pcxConfig['source-vpc'];
    const peerVpcConfig = getVpcConfig(vpcConfigs, pcxConfig.source, pcxSourceVpc);
    if (!VpcConfigType.is(peerVpcConfig)) {
      console.warn(`No configuration found for Peer VPC "${pcxSourceVpc}"`);
      continue;
    }
    const vpcOutput = VpcOutputFinder.tryFindOneByAccountAndRegionAndName({
      outputs,
      accountKey,
      vpcName: vpcConfig.name,
    });
    if (!vpcOutput) {
      console.warn(`No VPC Found in outputs for VPC name "${vpcConfig.name}"`);
      continue;
    }
    const peerVpcOutput = VpcOutputFinder.tryFindOneByAccountAndRegionAndName({
      outputs,
      accountKey: pcxConfig.source,
      vpcName: pcxSourceVpc,
    });
    if (!peerVpcOutput) {
      console.warn(`No VPC Found in outputs for VPC name "${pcxSourceVpc}"`);
      continue;
    }
    const peerOwnerId = getAccountId(accounts, pcxConfig.source);

    const pcx = new ec2.CfnVPCPeeringConnection(accountStack, `${vpcConfig.name}-${pcxSourceVpc}_pcx`, {
      vpcId: vpcOutput.vpcId,
      peerVpcId: peerVpcOutput.vpcId,
      peerRoleArn,
      peerOwnerId,
    });

    new StructuredOutput<PcxOutput>(accountStack, `PcxOutput${vpcConfig.name}`, {
      type: PcxOutputType,
      value: {
        pcxId: pcx.ref,
        vpcs: [
          {
            accountKey,
            vpcId: vpcOutput.vpcId,
            vpcName: vpcOutput.vpcName,
          },
          {
            accountKey: pcxConfig.source,
            vpcId: peerVpcOutput.vpcId,
            vpcName: peerVpcOutput.vpcName,
          },
        ],
      },
    });
  }

  // Creating Security Groups in shared accounts to respective accounts
  for (const { ouKey, accountKey, vpcConfig } of vpcConfigs) {
    const sharedToAccountKeys = getVpcSharedAccountKeys(accounts, vpcConfig, ouKey);
    const shareToAccountIds = Array.from(new Set(sharedToAccountKeys));
    if (sharedToAccountKeys.length > 0) {
      console.log(`Share VPC "${vpcConfig.name}" from Account "${accountKey}" to Accounts "${shareToAccountIds}"`);
    }

    const vpcOutput = VpcOutputFinder.tryFindOneByAccountAndRegionAndName({
      outputs,
      accountKey,
      region: vpcConfig.region,
      vpcName: vpcConfig.name,
    });
    if (!vpcOutput) {
      console.warn(`No VPC Found in outputs for VPC name "${vpcConfig.name}"`);
      continue;
    }

    for (const [index, sharedAccountKey] of shareToAccountIds.entries()) {
      // Initiating Security Group creation in shared account
      const accountStack = accountStacks.tryGetOrCreateAccountStack(sharedAccountKey, vpcConfig.region);
      if (!accountStack) {
        console.warn(`Cannot find account stack ${sharedAccountKey}`);
        continue;
      }

      const securityGroupStack = new cfn.NestedStack(
        accountStack,
        `SecurityGroups${vpcConfig.name}-Shared-${index + 1}`,
      );
      const securityGroups = new SecurityGroup(securityGroupStack, `SecurityGroups-SharedAccount-${index + 1}`, {
        securityGroups: vpcConfig['security-groups']!,
        vpcName: vpcConfig.name,
        vpcId: vpcOutput.vpcId,
        accountKey,
        vpcConfigs,
      });

      const accountId = getAccountId(accounts, accountKey);
      if (!accountId) {
        console.warn(`Cannot find account with key ${accountKey}`);
        continue;
      }

      // Add Tags Output
      const securityGroupsResources = Object.values(securityGroups.securityGroupNameMapping);

      new JsonOutputValue(securityGroupStack, `SecurityGroupOutput${vpcConfig.name}-${index}`, {
        type: 'SecurityGroupsOutput',
        value: {
          vpcId: vpcOutput.vpcId,
          vpcName: vpcConfig.name,
          securityGroupIds: securityGroups.securityGroups.map(securityGroup => ({
            securityGroupId: securityGroup.id,
            securityGroupName: securityGroup.name,
          })),
        },
      });

      new AddTagsToResourcesOutput(securityGroupStack, `OutputSharedResources${vpcConfig.name}-Shared-${index}`, {
        dependencies: securityGroupsResources,
        produceResources: () =>
          securityGroupsResources.map(securityGroup => ({
            resourceId: securityGroup.ref,
            resourceType: 'security-group',
            targetAccountIds: [accountId],
            tags: securityGroup.tags.renderTags(),
          })),
      });
    }
  }

  // Deploy Security Hub Step-1
  await securityHub.step1({
    accountStacks,
    accounts,
    config: acceleratorConfig,
    outputs,
  });

  // Central Services step 2
  await centralServices.step2({
    accountStacks,
    config: acceleratorConfig,
    accounts,
    context,
    outputs,
  });

  // Import all VPCs from all outputs
  const allVpcOutputs = VpcOutputFinder.findAll({ outputs });
  const allVpcs = allVpcOutputs.map(vpcDeployment.ImportedVpc.fromOutput);

  // Find the central bucket in the outputs
  const centralBucket = CentralBucketOutput.getBucket({
    accountStacks,
    config: acceleratorConfig,
    outputs,
  });

  await vpcDeployment.step2({
    accountBuckets,
    accountStacks,
    config: acceleratorConfig,
    outputs,
  });

  await madDeployment.step2({
    acceleratorExecutionRoleName: context.acceleratorExecutionRoleName,
    acceleratorPrefix: context.acceleratorPrefix,
    accountStacks,
    config: acceleratorConfig,
    outputs,
  });

  await firewallCluster.step3({
    accountBuckets,
    accountStacks,
    centralBucket,
    config: acceleratorConfig,
    outputs,
    vpcs: allVpcs,
  });

  await firewallManagement.step1({
    accountStacks,
    config: acceleratorConfig,
    vpcs: allVpcs,
    outputs,
  });

  await tgwDeployment.step2({
    accountStacks,
    accounts,
    outputs,
  });

  // Macie step 2
  await macie.step2({
    accountStacks,
    accounts,
    config: acceleratorConfig,
    outputs,
  });

  if (!acceleratorConfig['global-options']['alz-baseline']) {
    /**
     * Step 2 of https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_organizations.html
     * Step 3 of https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_organizations.html
     *
     * @param props accountStacks and config passed from phases
     */
    await guardDutyDeployment.step2({
      accountStacks,
      config: acceleratorConfig,
      accounts,
      outputs,
    });
  }

  const logBucket = accountBuckets[acceleratorConfig['global-options']['central-log-services'].account];
  await guardDutyDeployment.step3({
    accountStacks,
    config: acceleratorConfig,
    accounts,
    logBucket,
    outputs,
  });
}
