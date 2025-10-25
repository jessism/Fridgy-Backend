/**
 * Database Connection Module
 * Provides PostgreSQL-style query interface using Supabase
 */

const { getServiceClient } = require('./supabase');

/**
 * Execute a SQL query using Supabase
 * This provides a pg-compatible interface: db.query(sql, params)
 *
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters ($1, $2, etc.)
 * @returns {Promise<Object>} Result object with rows array
 */
async function query(text, params = []) {
  const supabase = getServiceClient();

  try {
    // Replace PostgreSQL placeholders ($1, $2) with Supabase-compatible ones
    let processedQuery = text;
    if (params && params.length > 0) {
      params.forEach((param, index) => {
        // Replace $1, $2, etc. with actual values
        // Note: This is a simple implementation. For production, consider using parameterized queries
        const placeholder = `$${index + 1}`;
        let value = param;

        // Handle different types
        if (value === null || value === undefined) {
          value = 'NULL';
        } else if (typeof value === 'string') {
          // Escape single quotes
          value = `'${value.replace(/'/g, "''")}'`;
        } else if (value instanceof Date) {
          value = `'${value.toISOString()}'`;
        } else if (typeof value === 'boolean') {
          value = value ? 'true' : 'false';
        } else if (typeof value === 'object') {
          // Handle JSON objects
          value = `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
        }

        processedQuery = processedQuery.replace(new RegExp(`\\${placeholder}\\b`, 'g'), value);
      });
    }

    // Execute raw SQL query using Supabase's RPC
    const { data, error } = await supabase.rpc('exec_sql', {
      query_text: processedQuery
    });

    if (error) {
      // If RPC doesn't work, try direct SQL execution via REST API
      // This is a fallback for Supabase instances that don't have exec_sql function
      console.log('[Database] RPC exec_sql not available, using direct execution');

      // For SELECT queries, try to infer the table and use .from()
      if (processedQuery.trim().toUpperCase().startsWith('SELECT')) {
        // This is a simplified fallback - for complex queries, you'll need custom logic
        throw new Error('Direct SQL SELECT queries require RPC function. Please create exec_sql RPC in Supabase.');
      }

      throw error;
    }

    // Return pg-compatible result
    return {
      rows: data || [],
      rowCount: data ? data.length : 0,
    };
  } catch (error) {
    console.error('[Database] Query error:', error);
    console.error('[Database] Query:', text);
    console.error('[Database] Params:', params);
    throw error;
  }
}

// For compatibility with services that need raw Supabase client
function getClient() {
  return getServiceClient();
}

module.exports = {
  query,
  getClient,
};
