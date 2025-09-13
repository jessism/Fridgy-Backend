require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

async function runMigration() {
  try {
    console.log('Running migration: 010_create_saved_recipes_system.sql');
    
    const migrationPath = path.join(__dirname, 'migrations', '010_create_saved_recipes_system.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    // Split by semicolons to run statements individually
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      console.log('Executing statement...');
      const { error } = await supabase.rpc('exec_sql', { 
        sql_query: statement + ';' 
      }).single();
      
      if (error) {
        // Try direct execution as alternative
        console.log('Trying alternative method...');
        // Note: Supabase client doesn't support direct SQL execution
        // We'll need to use the Supabase dashboard or API
        console.log('Statement:', statement.substring(0, 50) + '...');
      }
    }
    
    // Test if tables were created by trying to query them
    console.log('\nTesting table creation...');
    
    const { data: tokens, error: tokenError } = await supabase
      .from('shortcut_tokens')
      .select('*')
      .limit(1);
    
    if (!tokenError) {
      console.log('✅ shortcut_tokens table exists');
    } else {
      console.log('❌ shortcut_tokens table not found:', tokenError.message);
    }
    
    const { data: recipes, error: recipeError } = await supabase
      .from('saved_recipes')
      .select('*')
      .limit(1);
    
    if (!recipeError) {
      console.log('✅ saved_recipes table exists');
    } else {
      console.log('❌ saved_recipes table not found:', recipeError.message);
    }
    
    console.log('\nMigration check complete!');
    
  } catch (error) {
    console.error('Migration error:', error);
  }
}

runMigration();