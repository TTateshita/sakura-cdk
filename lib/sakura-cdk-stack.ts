import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';

export class SakuraCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC の作成
    const vpc = new ec2.Vpc(this, 'SakuraVPC', {
      maxAzs: 2,
      natGateways: 0,
    });

    // セキュリティグループの作成
    const sg = new ec2.SecurityGroup(this, 'SakuraSG', {
      vpc,
      description: 'Allow SSH and Pocketbase ports',
      allowAllOutbound: true,
    });

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH Access');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8090), 'Allow Pocketbase Access');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS Access');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTPS Access');




    // コンソール画面から作成しているEC2のキーペアを取得
    const keyPair = ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'sakura-backend-key');

    // キーペア取得コマンドアウトプット
    new CfnOutput(this, 'GetSSHKeyCommand', {
      value: `aws ssm get-parameter --name /ec2/keypair/${keyPair.keyPairName} --region ${this.region} --with-decryption --query Parameter.Value --output text`,
    })

    // S3バケットを作成　(バックアップ用)
    const sakuraBucket = new s3.Bucket(this, 'pbBackupBucket', {
      bucketName: 'pb-backup-sakura-bucket',
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // バケットのARNを出力
    new CfnOutput(this, 'pbBackupBucketArn', {
      value: sakuraBucket.bucketArn,
      description: 'ARN of the Pocketbase backup S3 bucket',
    });

    // EC2 インスタンスの作成
    const sakuraEc2 = new ec2.Instance(this, 'sakura-ec2', {
      instanceType: new ec2.InstanceType('t2.micro'),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: vpc,
      securityGroup: sg,
      keyPair: keyPair,
      vpcSubnets: { subnetType: SubnetType.PUBLIC }, // パブリックサブネットを指定

    });

    // EC2インスタンスにアタッチするIAMロール
    const ec2Role = new iam.Role(this, 'EC2S3BackupRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // S3へのフルアクセス権限を付与（必要に応じて最小権限に調整）
    sakuraBucket.grantReadWrite(ec2Role);

    // EC2インスタンスにロールを割り当て
    sakuraEc2.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')
    );

    // Elastic IPの作成
    const eip = new ec2.CfnEIP(this, 'SakuraElasticIP', {
      domain: 'vpc',

    });

    // Elastic IPをEC2インスタンスに関連付け
    new ec2.CfnEIPAssociation(this, 'EIPAssociation', {
      eip: eip.ref,
      instanceId: sakuraEc2.instanceId,
    });
    // Elastic IPを削除しないように設定
    eip.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // 既存のホストゾーンを参照
    const hostedZone = route53.HostedZone.fromLookup(this, 'ExistingHostedZone', {
      domainName: 'a.read-dx.com',
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: 'sakura',
      target: route53.RecordTarget.fromIpAddresses('18.182.126.160'), // 対象のIPアドレスに変更
    });

    // パブリック出力情報
    new cdk.CfnOutput(this, 'EC2 Public IP', {
      value: sakuraEc2.instancePublicIp,
    });

    // ElasticIP出力情報
    new cdk.CfnOutput(this, 'EC2 Elastic IP', {
      value: sakuraEc2.instancePublicIp,
      description: '固定IP(Elastic IP)',
    });
  }
}