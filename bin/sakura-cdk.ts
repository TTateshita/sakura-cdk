#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SakuraCdkStack } from '../lib/sakura-cdk-stack';

const app = new cdk.App();
new SakuraCdkStack(app, 'SakuraCdkStack', {
  env: {
    account: '643093502804',
    region: 'ap-northeast-1',
  },
});


app.synth();