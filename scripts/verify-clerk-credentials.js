#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createClerkClient } = require('@clerk/express');

async function main() {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY is required. Set it in the environment or local .env file.');
  }

  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const result = await client.users.getUserList({ limit: 1 });
  console.log(JSON.stringify({
    ok: true,
    userCount: Array.isArray(result.data) ? result.data.length : undefined,
    publishableKeyPrefix: String(process.env.CLERK_PUBLISHABLE_KEY || '').slice(0, 7),
  }));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    name: error.name,
    message: error.message,
    status: error.status,
  }));
  process.exitCode = 1;
});
