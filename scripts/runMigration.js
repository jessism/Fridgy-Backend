/**
 * Migration Runner Script
 * Runs SQL migration files against the Supabase database
 *
 * Usage: node Backend/scripts/runMigration.js <migration-file.sql>
 * Example: node Backend/scripts/runMigration.js Backend/migrations/020_add_email_preferences.sql
 */

const fs = require('fs');
const path = require('path');

// Load .env from Backend directory
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../config/database');

async function runMigration(migrationFile) {
  console.log('========================================');
  console.log('🚀 Running Database Migration');
  console.log('========================================');
  console.log('Migration file:', migrationFile);
  console.log('');

  try {
    // Read SQL file
    const sqlPath = path.resolve(migrationFile);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('📄 SQL file loaded successfully');
    console.log('');

    // Split SQL into individual statements (by semicolon)
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    console.log(`📊 Found ${statements.length} SQL statements to execute`);
    console.log('');

    let successCount = 0;
    let skipCount = 0;

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];

      // Skip comments
      if (statement.startsWith('--')) {
        skipCount++;
        continue;
      }

      try {
        console.log(`[${i + 1}/${statements.length}] Executing...`);

        // Show first 100 chars of statement
        const preview = statement.substring(0, 100).replace(/\n/g, ' ');
        console.log(`   ${preview}${statement.length > 100 ? '...' : ''}`);

        const result = await db.query(statement);

        if (result.rows && result.rows.length > 0) {
          console.log(`   ✅ Success (${result.rows.length} rows returned)`);

          // Show sample results for verification queries
          if (statement.toUpperCase().includes('SELECT') && result.rows.length <= 10) {
            console.log('   Results:', JSON.stringify(result.rows, null, 2));
          }
        } else {
          console.log(`   ✅ Success`);
        }

        successCount++;
      } catch (error) {
        // Check if it's an "already exists" error - these are OK
        if (error.message && (
          error.message.includes('already exists') ||
          error.message.includes('IF NOT EXISTS') ||
          error.message.includes('duplicate')
        )) {
          console.log(`   ⏭️  Skipped (already exists)`);
          skipCount++;
        } else {
          console.error(`   ❌ Failed:`, error.message);
          throw error;
        }
      }

      console.log('');
    }

    console.log('========================================');
    console.log('📈 Migration Summary');
    console.log('========================================');
    console.log(`Total statements: ${statements.length}`);
    console.log(`✅ Successfully executed: ${successCount}`);
    console.log(`⏭️  Skipped (already exists): ${skipCount}`);
    console.log('');
    console.log('✅ Migration complete!');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Get migration file from command line args
const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error('❌ Error: Migration file path required');
  console.error('');
  console.error('Usage: node Backend/scripts/runMigration.js <migration-file.sql>');
  console.error('Example: node Backend/scripts/runMigration.js Backend/migrations/020_add_email_preferences.sql');
  process.exit(1);
}

// Run migration
runMigration(migrationFile);
