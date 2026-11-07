// สิทธิ์ของ GitHub Actions ผ่าน OIDC (ไม่มี access key ค้างใน repo)
// assume ได้เฉพาะ job ที่รันใน environment "production" ของ repo นี้ ซึ่งต้องมีคนกดอนุมัติก่อน
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

export interface CiStackProps extends StackProps {
  repositories: ecr.IRepository[];
  /** owner/name ของ GitHub repo */
  githubRepo: string;
  /** มี OIDC provider ของ GitHub ในบัญชีอยู่แล้วให้ระบุ ARN (บัญชีหนึ่งมีได้ตัวเดียว) */
  githubOidcProviderArn?: string;
}

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const provider = props.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.githubOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'friday-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:environment:production`,
        },
      }),
    });
    // push image
    iam.Grant.addToPrincipal({ grantee: role, actions: ['ecr:GetAuthorizationToken'], resourceArns: ['*'] });
    for (const repo of props.repositories) repo.grantPullPush(role);
    // cdk deploy ใช้ role ที่ cdk bootstrap สร้างไว้
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`] }));
    // migration task และอ่าน output ของ stack
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:RunTask'], resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/friday-migrate:*`] }));
    // ลงทะเบียน revision ใหม่ของ friday-migrate ด้วย image ของ commit ที่ deploy (API ของ ECS ไม่รองรับจำกัด resource)
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:DescribeTasks', 'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'cloudformation:DescribeStacks'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [`arn:aws:iam::${this.account}:role/FridayApp-*`],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn, description: 'ใส่เป็น secret AWS_DEPLOY_ROLE_ARN ของ environment production ใน GitHub' });
  }
}
