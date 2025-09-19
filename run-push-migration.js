require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

async function runMigration() {
  try {
    console.log('Running push notifications migration...');

    // Read the migration file
    const migrationPath = path.join(__dirname, 'migrations', '015_create_push_notifications_tables.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf8');

    // Split into individual statements (basic split on semicolons)
    const statements = migrationSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let successCount = 0;
    let errorCount = 0;

    // Execute each statement
    for (const statement of statements) {
      // Skip comment-only statements
      if (statement.replace(/--.*$/gm, '').trim().length === 0) {
        continue;
      }

      try {
        console.log(`Executing: ${statement.substring(0, 50)}...`);

        const { error } = await supabase.rpc('exec_sql', {
          sql_query: statement + ';'
        }).catch(async (rpcError) => {
          // If RPC doesn't exist, try direct execution (for simpler statements)
          const { error: directError } = await supabase
            .from('_migrations')
            .select('*')
            .limit(0); // Just to test connection

          if (!directError) {
            console.log('Note: exec_sql RPC not available, some statements may need manual execution');
          }
          return { error: rpcError };
        });

        if (error) {
          console.error(`Error executing statement: ${error.message}`);
          errorCount++;
        } else {
          console.log('✓ Success');
          successCount++;
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`\nMigration summary:`);
    console.log(`✓ Successful statements: ${successCount}`);
    console.log(`✗ Failed statements: ${errorCount}`);

    if (errorCount > 0) {
      console.log('\n⚠️ Some statements failed. You may need to run them manually in the Supabase SQL editor.');
      console.log('Migration file location: Backend/migrations/015_create_push_notifications_tables.sql');
    } else {
      console.log('\n✅ Migration completed successfully!');
    }

  } catch (error) {
    console.error('Migration failed:', error);
    console.log('\nPlease run the migration manually in Supabase SQL editor:');
    console.log('File: Backend/migrations/015_create_push_notifications_tables.sql');
  }
}

// Run the migration
runMigration();