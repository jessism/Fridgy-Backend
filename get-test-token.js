/**
 * Quick script to get a test token
 */

require('dotenv').config();
const fetch = require('node-fetch');

const API_URL = process.env.BACKEND_URL || 'http://localhost:5000';

async function getToken() {
  console.log('\n🔑 Getting test token...\n');

  // Try to sign in with test credentials
  const testEmail = process.env.TEST_EMAIL || 'test@example.com';
  const testPassword = process.env.TEST_PASSWORD || 'test123';

  try {
    console.log('Attempting sign in...');
    console.log('Email:', testEmail);
    console.log('API URL:', API_URL);
    console.log('');

    const response = await fetch(`${API_URL}/api/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword
      })
    });

    const result = await response.json();

    if (response.ok && result.token) {
      console.log('✅ SUCCESS! Got token:\n');
      console.log(result.token);
      console.log('\n📋 Copy this and run:\n');
      console.log(`TEST_AUTH_TOKEN="${result.token}" node test-youtube-full.js\n`);
      console.log('Or add to .env file:');
      console.log(`TEST_AUTH_TOKEN=${result.token}\n`);
    } else {
      console.log('❌ Sign in failed:', result.error || result.message);
      console.log('\nTry creating a test user first or use different credentials.\n');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

getToken();
