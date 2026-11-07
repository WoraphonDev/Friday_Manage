// ที่เก็บ image แยกเป็น stack ของตัวเอง เพื่อให้ CI push image ได้ก่อน deploy stack ของแอป
// และลบ stack แอปทิ้งได้โดยไม่เสีย image เก่า (ใช้ย้อนเวอร์ชัน)
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

export class RegistryStack extends Stack {
  readonly api: ecr.Repository;
  readonly web: ecr.Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const repo = (name: string) => new ecr.Repository(this, name, {
      repositoryName: `friday-${name}`,
      imageScanOnPush: true,
      // tag เป็น commit SHA · ห้ามเขียนทับ เพื่อให้ย้อนกลับได้ตรงตัว
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { description: 'image ที่ไม่มี tag เกิน 7 วัน', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(7), rulePriority: 1 },
        { description: 'เก็บ 30 รุ่นล่าสุดไว้ย้อนกลับ', tagStatus: ecr.TagStatus.ANY, maxImageCount: 30, rulePriority: 2 },
      ],
    });
    this.api = repo('api');
    this.web = repo('web');
  }
}
