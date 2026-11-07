// Friday Manage บน AWS: VPC → RDS PostgreSQL 18 / ElastiCache Valkey / S3 → ECS Fargate (api, worker, web) หลัง ALB + TLS
// ค่าเริ่มต้นตั้งสำหรับช่วงแรก (ใช้กันเองในทีม · docs/tech-stack.md) เน้นค่าใช้จ่ายต่ำ ขยายได้ด้วย context ใน cdk.json
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Tags, Annotations } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface AppStackProps extends StackProps {
  apiRepo: ecr.IRepository;
  webRepo: ecr.IRepository;
  /** tag ของ image (commit SHA) ที่จะรัน */
  imageTag: string;
  /** โดเมนที่ผู้ใช้เปิด เช่น app.example.com · ใช้เป็น Origin ของ realtime และลิงก์ในอีเมล */
  domainName: string;
  /** ใบรับรอง ACM ใน region เดียวกัน · ไม่ระบุ = เปิดเฉพาะ HTTP (ใช้ synth / ทดลองเท่านั้น) */
  certificateArn?: string;
  /** ขนาดเครื่อง · ค่าเริ่มต้นเล็กสุดที่ใช้งานได้ */
  dbInstanceType?: string;
  dbMultiAz?: boolean;
  cacheNodeType?: string;
  apiCount?: number;
  webCount?: number;
  /** deploy ครั้งแรก: สร้างทุกอย่างแต่ยังไม่เปิด service จนกว่า migration จะสร้างตารางเสร็จ */
  pauseServices?: boolean;
}

// รหัสผ่านใส่ใน URL ฐานข้อมูลตรง ๆ (infra/docker/api-entrypoint.sh) จึงตัดอักขระที่ต้อง encode
const URL_SAFE_EXCLUDE = ' %+~`#$&*()|[]{}:;<>?!\'/@"\\=,.^';

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    Tags.of(this).add('app', 'friday-manage');
    const origin = `${props.certificateArn ? 'https' : 'http'}://${props.domainName}`;

    // ---------------------------------------------------------------- เครือข่าย
    // NAT 1 ตัว: งานออกอินเทอร์เน็ต (LINE, SMTP, GitHub, Stripe, GlitchTip) · เพิ่มเป็น 2 เมื่อต้องการทน AZ ล่ม
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // คำอธิบาย Security group ต้องเป็น ASCII ตามข้อจำกัดของ EC2
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'Friday ALB: HTTP/HTTPS from the internet' });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    const appSg = new ec2.SecurityGroup(this, 'AppSg', { vpc, description: 'Friday ECS tasks: api, worker, web' });
    appSg.addIngressRule(albSg, ec2.Port.tcp(3001), 'ALB to API');
    appSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'ALB to Web');
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Friday PostgreSQL: from app tasks only', allowAllOutbound: false });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(5432));
    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'Friday Valkey: from app tasks only', allowAllOutbound: false });
    cacheSg.addIngressRule(appSg, ec2.Port.tcp(6379));

    // ---------------------------------------------------------------- Secrets
    // friday_owner = เจ้าของ schema (รัน migration) · friday_api ถูกบังคับด้วย RLS · friday_worker มี BYPASSRLS
    const ownerCredentials = rds.Credentials.fromGeneratedSecret('friday_owner', { secretName: 'friday/db/owner', excludeCharacters: URL_SAFE_EXCLUDE });
    const loginSecret = (name: string) => new sm.Secret(this, `Db${name}Password`, {
      secretName: `friday/db/${name.toLowerCase()}`,
      description: `รหัสผ่านบัญชี friday_${name.toLowerCase()} (deploy-migrate ตั้งให้ใน PostgreSQL)`,
      generateSecretString: { passwordLength: 40, excludePunctuation: true, excludeCharacters: URL_SAFE_EXCLUDE },
    });
    const apiDbPassword = loginSecret('Api');
    const workerDbPassword = loginSecret('Worker');
    // ค่าที่ต้องกรอกเองก่อน deploy ครั้งแรก (API ไม่เปิดถ้า production ไม่มี Stripe) · AUTH_SECRET สร้างให้
    const appSecret = new sm.Secret(this, 'AppSecret', {
      secretName: 'friday/app',
      description: 'ค่าลับของแอป · กรอก STRIPE_*, SMTP_PASS, SENTRY_DSN, GITHUB_* ใน Console ก่อน deploy service',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SMTP_PASS: '', SENTRY_DSN: '',
          GITHUB_CLIENT_SECRET: '', GITHUB_WEBHOOK_SECRET: '', GITHUB_APP_PRIVATE_KEY: '', ETAX_WEBHOOK_SECRET: '',
        }),
        generateStringKey: 'AUTH_SECRET',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // ---------------------------------------------------------------- PostgreSQL 18
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18 }),
      instanceType: new ec2.InstanceType(props.dbInstanceType ?? 't4g.small'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      credentials: ownerCredentials,
      databaseName: 'friday',
      multiAz: props.dbMultiAz ?? false,
      allocatedStorage: 20,
      maxAllocatedStorage: 200,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(14),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      enablePerformanceInsights: false,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      // บังคับ TLS · แอปต่อด้วย sslmode=verify-full และ CA ของ RDS ใน image
      parameters: { 'rds.force_ssl': '1', timezone: 'UTC' },
    });

    // ---------------------------------------------------------------- Valkey (BullMQ)
    // BullMQ ต้องการ maxmemory-policy=noeviction ไม่งั้นงานในคิวหายเมื่อหน่วยความจำเต็ม
    const cacheParams = new elasticache.CfnParameterGroup(this, 'CacheParams', {
      cacheParameterGroupFamily: 'valkey8',
      description: 'Friday BullMQ requires noeviction',
      properties: { 'maxmemory-policy': 'noeviction' },
    });
    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Friday Valkey',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    const cache = new elasticache.CfnReplicationGroup(this, 'Cache', {
      replicationGroupDescription: 'Friday Manage queue',
      engine: 'valkey',
      engineVersion: '8.0',
      cacheNodeType: props.cacheNodeType ?? 'cache.t4g.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      cacheParameterGroupName: cacheParams.ref,
      cacheSubnetGroupName: cacheSubnets.ref,
      securityGroupIds: [cacheSg.securityGroupId],
      snapshotRetentionLimit: 3,
    });
    const valkeyUrl = `rediss://${cache.attrPrimaryEndPointAddress}:${cache.attrPrimaryEndPointPort}`;

    // ---------------------------------------------------------------- S3 ไฟล์แนบ
    const files = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(2) }],
      // เบราว์เซอร์ดาวน์โหลด / อัปโหลดผ่าน presigned URL จากโดเมนของแอปเท่านั้น
      cors: [{ allowedOrigins: [origin], allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD], allowedHeaders: ['*'], maxAge: 3600 }],
    });

    // ---------------------------------------------------------------- ECS
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: 'friday', enableFargateCapacityProviders: true });
    const logGroup = new logs.LogGroup(this, 'Logs', { logGroupName: '/friday/app', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    const apiImage = ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.imageTag);
    const webImage = ecs.ContainerImage.fromEcrRepository(props.webRepo, props.imageTag);
    // Graviton (ARM64) ถูกกว่า x86 · CI build image บน runner ARM
    const runtimePlatform = { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX };

    const dbEnv = { DB_HOST: db.instanceEndpoint.hostname, DB_PORT: db.instanceEndpoint.port.toString(), DB_NAME: 'friday', DB_SSLMODE: 'verify-full' };
    const apiEnv = {
      NODE_ENV: 'production',
      PORT: '3001',
      WEB_URL: origin,
      APP_URL: origin,
      API_PUBLIC_URL: origin,
      VALKEY_URL: valkeyUrl,
      QUEUE_PREFIX: 'friday',
      S3_BUCKET: files.bucketName,
      S3_REGION: this.region,
      SENTRY_ENVIRONMENT: 'production',
      APP_VERSION: props.imageTag,
      ...dbEnv,
    };
    const appSecretKeys = ['AUTH_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SMTP_PASS', 'SENTRY_DSN', 'GITHUB_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'ETAX_WEBHOOK_SECRET'];
    const apiSecrets: Record<string, ecs.Secret> = {
      // API ใช้ทั้งบัญชี RLS และบัญชีระบบ (Login / Session / Webhook ขาเข้า)
      DB_API_PASSWORD: ecs.Secret.fromSecretsManager(apiDbPassword),
      DB_WORKER_PASSWORD: ecs.Secret.fromSecretsManager(workerDbPassword),
      ...Object.fromEntries(appSecretKeys.map((k) => [k, ecs.Secret.fromSecretsManager(appSecret, k)])),
    };

    const taskDef = (name: string, cpu: number, memoryLimitMiB: number) => {
      const def = new ecs.FargateTaskDefinition(this, `${name}Task`, { family: `friday-${name.toLowerCase()}`, cpu, memoryLimitMiB, runtimePlatform });
      files.grantReadWrite(def.taskRole);
      return def;
    };
    const container = (def: ecs.FargateTaskDefinition, name: string, opts: Omit<ecs.ContainerDefinitionOptions, 'logging'>) =>
      def.addContainer(name, { ...opts, logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }), readonlyRootFilesystem: false });

    const apiDef = taskDef('Api', 512, 1024);
    container(apiDef, 'api', {
      image: apiImage, environment: apiEnv, secrets: apiSecrets,
      portMappings: [{ containerPort: 3001 }],
      healthCheck: { command: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: Duration.seconds(15), startPeriod: Duration.seconds(30) },
    });
    const workerDef = taskDef('Worker', 256, 512);
    container(workerDef, 'worker', { image: apiImage, command: ['node', 'dist/worker.js'], environment: { ...apiEnv, WORKER_CONCURRENCY: '5' }, secrets: apiSecrets });
    const webDef = taskDef('Web', 256, 512);
    container(webDef, 'web', {
      image: webImage,
      environment: { NODE_ENV: 'production', PORT: '3000', HOSTNAME: '0.0.0.0', SENTRY_ENVIRONMENT: 'production', APP_VERSION: props.imageTag },
      secrets: { SENTRY_DSN: ecs.Secret.fromSecretsManager(appSecret, 'SENTRY_DSN') },
      portMappings: [{ containerPort: 3000 }],
    });
    // Migration: รันเป็น task ครั้งเดียวก่อนอัปเดต service (.github/workflows/deploy.yml)
    const migrateDef = taskDef('Migrate', 256, 512);
    container(migrateDef, 'migrate', {
      image: apiImage,
      command: ['node', '/app/packages/db/deploy-migrate.mjs'],
      environment: dbEnv,
      secrets: {
        DB_OWNER_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
        DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        DB_API_PASSWORD: ecs.Secret.fromSecretsManager(apiDbPassword),
        DB_WORKER_PASSWORD: ecs.Secret.fromSecretsManager(workerDbPassword),
      },
    });

    const service = (name: string, def: ecs.FargateTaskDefinition, desiredCount: number, minHealthyPercent: number) => new ecs.FargateService(this, `${name}Service`, {
      cluster, taskDefinition: def, serviceName: `friday-${name.toLowerCase()}`, desiredCount,
      securityGroups: [appSg], vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, assignPublicIp: false,
      minHealthyPercent, maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1 }],
      enableExecuteCommand: false,
    });
    const count = (n: number) => (props.pauseServices ? 0 : n);
    const apiService = service('Api', apiDef, count(props.apiCount ?? 1), 100);
    const webService = service('Web', webDef, count(props.webCount ?? 1), 100);
    // Worker ปิดหลังงานที่รันอยู่เสร็จ (SIGTERM) · ช่วง deploy ไม่ต้องมี 2 ตัวพร้อมกัน
    service('Worker', workerDef, count(1), 0);

    // ---------------------------------------------------------------- ALB + TLS
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc, internetFacing: true, securityGroup: albSg, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // WebSocket ของ realtime ค้างได้นานกว่าค่าเริ่มต้น 60 วินาที
      idleTimeout: Duration.seconds(300),
      dropInvalidHeaderFields: true,
    });
    const listener = props.certificateArn
      ? alb.addListener('Https', { port: 443, certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS })
      : alb.addListener('Http', { port: 80 });
    if (props.certificateArn) alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    else Annotations.of(this).addWarningV2('friday:no-tls', 'ไม่ได้ตั้ง certificateArn: ALB เปิดเฉพาะ HTTP · ใช้สำหรับ synth / ทดลองเท่านั้น');

    listener.addTargets('Web', {
      port: 3000, protocol: elbv2.ApplicationProtocol.HTTP, targets: [webService],
      healthCheck: { path: '/login', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(15),
    });
    // /api/* ตรงไป API (รวม WebSocket /api/v1/realtime) ไม่ต้องผ่าน rewrite ของ Next
    listener.addTargets('Api', {
      priority: 10, conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      port: 3001, protocol: elbv2.ApplicationProtocol.HTTP, targets: [apiService],
      healthCheck: { path: '/healthz', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(30),
    });

    // ---------------------------------------------------------------- ค่าที่ workflow deploy ใช้
    new CfnOutput(this, 'LoadBalancerDns', { value: alb.loadBalancerDnsName, description: 'ชี้ DNS ของโดเมนมาที่นี่ (CNAME / Alias)' });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'MigrateTaskDefinition', { value: migrateDef.taskDefinitionArn });
    new CfnOutput(this, 'TaskSubnets', { value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(',') });
    new CfnOutput(this, 'TaskSecurityGroup', { value: appSg.securityGroupId });
    new CfnOutput(this, 'FilesBucket', { value: files.bucketName });
    new CfnOutput(this, 'AppSecretName', { value: appSecret.secretName, description: 'กรอกค่าใน Secrets Manager ก่อน deploy service ครั้งแรก' });
  }
}
