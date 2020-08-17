import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import { ServiceLinkedRole } from '@aws-accelerator/cdk-constructs/src/iam';
import { AcceleratorConfig } from '@aws-accelerator/common-config/src';
import { CfnSleep } from '@aws-accelerator/custom-resource-cfn-sleep';
import { AccountStacks } from '../../common/account-stacks';
import { CfnRsyslogAutoScalingRoleOutput, CfnRsyslogImageIdOutputTypeOutput } from './outputs';
import { AccountRegionEbsEncryptionKeys } from '../defaults';

export interface RsyslogStep1Props {
  acceleratorName: string;
  acceleratorPrefix: string;
  accountEbsEncryptionKeys: AccountRegionEbsEncryptionKeys;
  accountStacks: AccountStacks;
  config: AcceleratorConfig;
}

export async function step1(props: RsyslogStep1Props) {
  const { accountStacks, accountEbsEncryptionKeys, config, acceleratorName, acceleratorPrefix } = props;
  for (const [accountKey, accountConfig] of config.getMandatoryAccountConfigs()) {
    const rsyslogDeploymentConfig = accountConfig.deployments?.rsyslog;
    if (!rsyslogDeploymentConfig || !rsyslogDeploymentConfig.deploy) {
      continue;
    }

    const region = rsyslogDeploymentConfig.region;
    const accountEbsEncryptionKey = accountEbsEncryptionKeys[accountKey]?.[region];
    if (!accountEbsEncryptionKey) {
      console.warn(`Could not find EBS encryption key in account "${accountKey}" to deploy service-linked role`);
      continue;
    }

    const accountStack = accountStacks.tryGetOrCreateAccountStack(accountKey);
    if (!accountStack) {
      console.warn(`Cannot find account stack ${accountStack}`);
      continue;
    }

    // Create the auto scaling service-linked role manually in order to attach the policy to the default EBS KMS key
    const role = new ServiceLinkedRole(accountStack, 'RsyslogSlr', {
      awsServiceName: 'autoscaling.amazonaws.com',
      customSuffix: `${acceleratorName}-Rsyslog`,
      description: `${acceleratorPrefix}Autoscaling Role for ${acceleratorName}`,
    });

    // Sleep 30 seconds after creation of the role, otherwise the key policy creation will fail
    const roleSleep = new CfnSleep(accountStack, 'RsyslogSlrSleep', {
      sleep: 30 * 1000,
    });
    roleSleep.node.addDependency(role);

    // Make sure to create the role before using it in the key policy
    accountEbsEncryptionKey.node.addDependency(roleSleep);

    // See https://docs.aws.amazon.com/autoscaling/ec2/userguide/key-policy-requirements-EBS-encryption.html
    accountEbsEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow service-linked role use of the CMK',
        principals: [new iam.ArnPrincipal(role.roleArn)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
      }),
    );

    accountEbsEncryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow attachment of persistent resources',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(role.roleArn)],
        actions: ['kms:CreateGrant'],
        resources: ['*'],
        conditions: {
          Bool: {
            'kms:GrantIsForAWSResource': 'true',
          },
        },
      }),
    );

    new CfnRsyslogAutoScalingRoleOutput(accountStack, 'RsyslogSlrOutput', {
      roleArn: role.roleArn,
    });

    const imageId = ssm.StringParameter.valueForTypedStringParameter(
      accountStack,
      rsyslogDeploymentConfig['ssm-image-id'],
      ssm.ParameterType.AWS_EC2_IMAGE_ID,
    );

    new CfnRsyslogImageIdOutputTypeOutput(accountStack, 'RsyslogImageIdOutput', {
      imageId,
      imagePath: rsyslogDeploymentConfig['ssm-image-id'],
      imageKey: 'RsyslogAutoScalingImageId',
    });
  }
}
