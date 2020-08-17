import * as AWS from 'aws-sdk';
import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceDeleteEvent } from 'aws-lambda';
import { errorHandler } from '@aws-accelerator/custom-resource-runtime-cfn-response';

const ec2 = new AWS.EC2();

export interface HandlerProperties {
  KmsKeyId: string;
}

export const handler = errorHandler(onEvent);

async function onEvent(event: CloudFormationCustomResourceEvent) {
  console.log(`Setting EBS default encryption...`);
  console.log(JSON.stringify(event, null, 2));

  // tslint:disable-next-line: switch-default
  switch (event.RequestType) {
    case 'Create':
      return onCreate(event);
    case 'Update':
      return onUpdate(event);
    case 'Delete':
      return onDelete(event);
  }
}

async function onCreate(event: CloudFormationCustomResourceEvent) {
  const properties = (event.ResourceProperties as unknown) as HandlerProperties;

  await ec2.enableEbsEncryptionByDefault().promise();
  await ec2
    .modifyEbsDefaultKmsKeyId({
      KmsKeyId: properties.KmsKeyId,
    })
    .promise();

  return {
    physicalResourceId: properties.KmsKeyId,
  };
}

async function onUpdate(event: CloudFormationCustomResourceEvent) {
  return onCreate(event);
}

async function onDelete(event: CloudFormationCustomResourceDeleteEvent) {
  // const getEbsDefaultKmsKeyId = await ec2.getEbsDefaultKmsKeyId().promise();
  // // If the current EBS default encryption key is the same as we initially set, then reset the key
  // if (getEbsDefaultKmsKeyId.KmsKeyId === event.PhysicalResourceId) {
  //   await ec2.resetEbsDefaultKmsKeyId().promise();
  // }
}
