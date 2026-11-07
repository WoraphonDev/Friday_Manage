// cdk synth / deploy · ค่าตั้งอยู่ใน cdk.json › context หรือส่ง -c key=value
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack.ts';
import { CiStack } from '../lib/ci-stack.ts';
import { RegistryStack } from '../lib/registry-stack.ts';

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key) as string | undefined;
// Region ประเทศไทย (docs/tech-stack.md) · บัญชีมาจาก credential ตอน deploy · synth ไม่ต้องมีบัญชี
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx('region') ?? 'ap-southeast-7' };

const registry = new RegistryStack(app, 'FridayRegistry', { env });
new CiStack(app, 'FridayCi', { env, repositories: [registry.api, registry.web], githubRepo: ctx('githubRepo') ?? 'WoraphonDev/Friday_Manage', githubOidcProviderArn: ctx('githubOidcProviderArn') });
new AppStack(app, 'FridayApp', {
  env,
  apiRepo: registry.api,
  webRepo: registry.web,
  imageTag: ctx('imageTag') ?? 'latest',
  domainName: ctx('domainName') ?? 'friday.example.com',
  certificateArn: ctx('certificateArn') || undefined,
  dbInstanceType: ctx('dbInstanceType'),
  dbMultiAz: ctx('dbMultiAz') === 'true',
  cacheNodeType: ctx('cacheNodeType'),
  apiCount: ctx('apiCount') ? Number(ctx('apiCount')) : undefined,
  webCount: ctx('webCount') ? Number(ctx('webCount')) : undefined,
  pauseServices: ctx('pauseServices') === 'true',
});
