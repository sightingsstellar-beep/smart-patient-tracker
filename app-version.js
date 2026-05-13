'use strict';

const packageJson = require('./package.json');

const APP_VERSION = packageJson.version;
const ALEXA_SKILL_VERSION = process.env.ALEXA_SKILL_VERSION || APP_VERSION;

function releaseInfo() {
  return {
    name: packageJson.name,
    version: APP_VERSION,
    release: process.env.RELEASE_VERSION || null,
    environment: process.env.NODE_ENV || 'development',
    commit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT_SHA ||
      process.env.COMMIT_SHA ||
      null,
    builtAt: process.env.BUILD_TIMESTAMP || null,
    components: {
      webApp: {
        name: packageJson.name,
        version: APP_VERSION,
      },
      alexaSkill: {
        name: 'Glide Bedside',
        invocationName: 'fluid monitor',
        version: ALEXA_SKILL_VERSION,
      },
    },
  };
}

module.exports = {
  APP_VERSION,
  ALEXA_SKILL_VERSION,
  releaseInfo,
};
