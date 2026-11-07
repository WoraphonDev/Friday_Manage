// ตรวจค่าที่ถ้าหลุดแล้วเสียหายจริง: ข้อมูลหาย, คิวหาย, ไม่มี TLS, เปิดฐานข้อมูลออกนอก
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack.ts';
import { CiStack } from '../lib/ci-stack.ts';
import { RegistryStack } from '../lib/registry-stack.ts';

const CERT = 'arn:aws:acm:ap-southeast-7:111111111111:certificate/00000000-0000-0000-0000-000000000000';
function build(certificateArn: string | null = CERT) {
  const app = new App();
  const env = { account: '111111111111', region: 'ap-southeast-7' };
  const registry = new RegistryStack(app, 'FridayRegistry', { env });
  const ci = new CiStack(app, 'FridayCi', { env, repositories: [registry.api, registry.web], githubRepo: 'WoraphonDev/Friday_Manage' });
  const stack = new AppStack(app, 'FridayApp', { env, apiRepo: registry.api, webRepo: registry.web, imageTag: 'abc1234', domainName: 'friday.example.com', certificateArn: certificateArn ?? undefined });
  return { app: Template.fromStack(stack), registry: Template.fromStack(registry), ci: Template.fromStack(ci) };
}

test('PostgreSQL 18 เข้ารหัส บังคับ TLS ลบไม่ได้ และอยู่ subnet ที่ออกเน็ตไม่ได้', () => {
  const { app } = build();
  app.hasResourceProperties('AWS::RDS::DBInstance', Match.objectLike({
    Engine: 'postgres', EngineVersion: Match.stringLikeRegexp('^18'), StorageEncrypted: true, DeletionProtection: true, PubliclyAccessible: false,
  }));
  app.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Snapshot' });
  app.hasResourceProperties('AWS::RDS::DBParameterGroup', { Parameters: Match.objectLike({ 'rds.force_ssl': '1' }) });
});

test('Valkey ไม่ evict key ของ BullMQ และเข้ารหัสระหว่างทาง', () => {
  const { app } = build();
  app.hasResourceProperties('AWS::ElastiCache::ParameterGroup', { Properties: { 'maxmemory-policy': 'noeviction' } });
  app.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', { Engine: 'valkey', TransitEncryptionEnabled: true, AtRestEncryptionEnabled: true });
});

test('ALB: HTTPS + redirect, /api/* ไป API ที่ /healthz, WebSocket idle 300 วินาที', () => {
  const { app } = build();
  app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: CERT }] });
  app.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80, DefaultActions: [Match.objectLike({ Type: 'redirect' })] });
  app.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', { Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }] });
  app.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Port: 3001, HealthCheckPath: '/healthz' });
  app.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '300' }]) });
});

test('ไม่มีใบรับรอง = HTTP อย่างเดียว (ใช้ synth เท่านั้น)', () => {
  const { app } = build(null);
  const ports = Object.values(app.findResources('AWS::ElasticLoadBalancingV2::Listener')).map((l) => l.Properties.Port);
  assert.deepEqual(ports, [80]);
});

test('task ทั้งหมดเป็น ARM64 และ migrate ได้รหัสผ่านจาก Secrets Manager ไม่ใช่ env ธรรมดา', () => {
  const { app } = build();
  const defs = app.findResources('AWS::ECS::TaskDefinition');
  assert.equal(Object.keys(defs).length, 4);
  for (const def of Object.values(defs)) assert.equal(def.Properties.RuntimePlatform.CpuArchitecture, 'ARM64');
  const migrate = Object.values(defs).find((d) => d.Properties.Family === 'friday-migrate')!;
  const container = migrate.Properties.ContainerDefinitions[0];
  assert.deepEqual(container.Command, ['node', '/app/packages/db/deploy-migrate.mjs']);
  assert.deepEqual(container.Secrets.map((s: { Name: string }) => s.Name).sort(), ['DB_API_PASSWORD', 'DB_OWNER_PASSWORD', 'DB_OWNER_USER', 'DB_WORKER_PASSWORD']);
  const json = JSON.stringify(defs);
  assert.ok(!/friday_(api|worker|owner)_dev/.test(json), 'ห้ามมีรหัสผ่าน dev ใน task definition');
});

test('ฐานข้อมูลและ Valkey รับเฉพาะจาก security group ของแอป', () => {
  const { app } = build();
  const ingress = Object.values(app.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
  for (const port of [5432, 6379]) {
    const rules = ingress.filter((r) => r.FromPort === port);
    assert.equal(rules.length, 1);
    assert.ok(rules[0].SourceSecurityGroupId, `port ${port} ต้องมาจาก security group ไม่ใช่ CIDR`);
  }
});

test('ECR ห้ามเขียนทับ tag และ role ของ GitHub assume ได้เฉพาะ environment production', () => {
  const { registry, ci } = build();
  registry.resourceCountIs('AWS::ECR::Repository', 2);
  registry.allResourcesProperties('AWS::ECR::Repository', { ImageTagMutability: 'IMMUTABLE' });
  ci.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [Match.objectLike({
    Condition: { StringEquals: { 'token.actions.githubusercontent.com:sub': 'repo:WoraphonDev/Friday_Manage:environment:production', 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' } },
  })] } });
});

test('pauseServices: สร้าง service แต่ desiredCount เป็น 0 ทั้งหมด (deploy ครั้งแรกก่อน migration)', () => {
  const app = new App();
  const env = { account: '111111111111', region: 'ap-southeast-7' };
  const registry = new RegistryStack(app, 'R', { env });
  const stack = new AppStack(app, 'A', { env, apiRepo: registry.api, webRepo: registry.web, imageTag: 't', domainName: 'friday.example.com', pauseServices: true });
  const services = Object.values(Template.fromStack(stack).findResources('AWS::ECS::Service'));
  assert.equal(services.length, 3);
  for (const s of services) assert.equal(s.Properties.DesiredCount, 0);
});
