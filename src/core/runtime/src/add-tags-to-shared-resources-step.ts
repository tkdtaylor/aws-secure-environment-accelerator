import { TagResources } from '@aws-accelerator/common/src/aws/resource-tagging';
import { STS } from '@aws-accelerator/common/src/aws/sts';
import { S3 } from '@aws-accelerator/common/src/aws/s3';
import { StackOutput, getStackJsonOutput } from '@aws-accelerator/common-outputs/src/stack-output';

const ALLOWED_RESOURCE_TYPES = ['subnet', 'security-group', 'vpc', 'tgw-attachment'];

interface CreateTagsRequestInput {
  assumeRoleName: string;
  stackOutputBucketName: string;
  stackOutputBucketKey: string;
  stackOutputVersion: string;
}

interface Tag {
  key: string;
  value: string;
}

interface AddTagToResourceOutput {
  resourceId: string;
  resourceType: string;
  targetAccountIds: string[];
  tags: Tag[];
}

type AddTagToResourceOutputs = AddTagToResourceOutput[];

const s3 = new S3();
const sts = new STS();

export const handler = async (input: CreateTagsRequestInput) => {
  console.log(`Adding tags to shared resource...`);
  console.log(JSON.stringify(input, null, 2));

  const { assumeRoleName, stackOutputBucketName, stackOutputBucketKey, stackOutputVersion } = input;

  const outputsString = await s3.getObjectBodyAsString({
    Bucket: stackOutputBucketName,
    Key: stackOutputBucketKey,
    VersionId: stackOutputVersion,
  });
  const outputs = JSON.parse(outputsString) as StackOutput[];

  const addTagsToResourcesOutputs: AddTagToResourceOutputs[] = getStackJsonOutput(outputs, {
    outputType: 'AddTagsToResources',
  });

  for (const addTagsToResourcesOutput of addTagsToResourcesOutputs) {
    for (const addTagsToResources of addTagsToResourcesOutput) {
      const { resourceId, resourceType, targetAccountIds, tags } = addTagsToResources;
      for (const targetAccountId of targetAccountIds) {
        console.log(`Tagging resource "${resourceId}" in account "${targetAccountId}"`);

        const credentials = await sts.getCredentialsForAccountAndRole(targetAccountId, assumeRoleName);
        if (ALLOWED_RESOURCE_TYPES.includes(resourceType)) {
          try {
            const tagResources = new TagResources(credentials);
            await tagResources.createTags({
              Resources: [resourceId],
              Tags: tags.map(t => ({ Key: t.key, Value: t.value })),
            });
          } catch (e) {
            console.warn(`Cannot tag resource "${resourceId}" in account "${targetAccountId}": ${e}`);
          }
        } else {
          console.warn(`Unsupported resource type "${resourceType}"`);
        }
      }
    }
  }

  return {
    status: 'SUCCESS',
    statusReason: `Added tags for all the shared resources`,
  };
};
