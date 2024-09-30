import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class SakuraCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC の作成
    const vpc = new ec2.Vpc(this, 'SakuraVPC', {
      maxAzs: 2,
    });

    // セキュリティグループの作成
    const sg = new ec2.SecurityGroup(this, 'SakuraSG', {
      vpc,
      description: 'Allow SSH and Pocketbase ports',
      allowAllOutbound: true,
    });

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH Access');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8090), 'Allow Pocketbase Access');


    // キーペア作成
    const cfnKeyPair = new ec2.CfnKeyPair(this, 'CfnKeyPair', {
      keyName: 'sakura-key',
    })

    cfnKeyPair.applyRemovalPolicy(RemovalPolicy.DESTROY)

    // キーペア取得コマンドアウトプット
    new CfnOutput(this, 'GetSSHKeyCommand', {
      value: `aws ssm get-parameter --name /ec2/keypair/${cfnKeyPair.getAtt('KeyPairId')} --region ${this.region} --with-decryption --query Parameter.Value --output text`,
    })

    // S3バケットを作成
    const sakuraBucket = new s3.Bucket(this, 'pbBackupBucket', {
      bucketName: 'pbbackup-sakura-bucket',
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
      keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'sakura-key'),
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


    // User Data を使用して Pocketbase をインストールおよび起動
    sakuraEc2.userData.addCommands(
      'yum update -y',
      'yum install -y wget unzip',
      'wget https://github.com/pocketbase/pocketbase/releases/download/v0.22.21/pocketbase_0.22.21_linux_amd64.zip',
      'unzip pocketbase_0.22.21_linux_amd64.zip -d /home/ec2-user/pocketbase',
      'chmod +x /home/ec2-user/pocketbase/pocketbase',
      'nohup /home/ec2-user/pocketbase/pocketbase serve --http 0.0.0.0:8090 &',

      // AWS CLIのインストール
      'yum install -y awscli',

      // バックアップスクリプトの作成
      'echo "#!/bin/bash" > /home/ec2-user/backup_pocketbase.sh',
      'echo "tar -czf /home/ec2-user/pocketbase_backup_$(date +%F).tar.gz /home/ec2-user/pocketbase/pb_data" >> /home/ec2-user/backup_pocketbase.sh',
      'echo "aws s3 cp /home/ec2-user/pocketbase_backup_$(date +%F).tar.gz s3://PocketbaseBackupBucketName/" >> /home/ec2-user/backup_pocketbase.sh',
      'chmod +x /home/ec2-user/backup_pocketbase.sh',

      // cronジョブの設定（毎日深夜2時に実行）
      'echo "0 2 * * * /home/ec2-user/backup_pocketbase.sh >> /var/log/backup.log 2>&1" >> /etc/crontab',
      'service crond restart'
    );

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