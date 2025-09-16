require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Test what's actually stored in the database for recipe images
async function testDatabaseImages() {
  console.log('🗄️ Testing Database Image Storage');
  console.log('==================================\n');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  try {
    // Get the most recent recipes, especially from Instagram
    const { data: recipes, error } = await supabase
      .from('saved_recipes')
      .select('id, title, image, source_type, source_url, created_at')
      .eq('source_type', 'instagram')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('❌ Database query error:', error);
      return;
    }

    console.log(`📊 Found ${recipes.length} recent Instagram recipes:\n`);

    recipes.forEach((recipe, index) => {
      console.log(`Recipe ${index + 1}:`);
      console.log(`  ID: ${recipe.id}`);
      console.log(`  Title: ${recipe.title}`);
      console.log(`  Source URL: ${recipe.source_url}`);
      console.log(`  Created: ${new Date(recipe.created_at).toLocaleString()}`);

      if (recipe.image) {
        console.log(`  ✅ Image URL: ${recipe.image}`);

        // Check if it's an Instagram image
        const isInstagramImage = recipe.image.includes('instagram') ||
                                 recipe.image.includes('fbcdn') ||
                                 recipe.image.includes('scontent');
        console.log(`  📸 Instagram CDN: ${isInstagramImage ? 'Yes' : 'No'}`);

        // Check if it's the placeholder
        const isPlaceholder = recipe.image.includes('unsplash') ||
                            recipe.image.includes('placeholder');
        console.log(`  🖼️ Placeholder: ${isPlaceholder ? 'Yes' : 'No'}`);
      } else {
        console.log(`  ❌ No image URL stored`);
      }

      console.log('');
    });

    // Test if any recipes have the specific reel URL we were testing
    const testReelUrl = 'https://www.instagram.com/reel/Cygngu3Pgoq/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA==';

    const { data: testRecipe, error: testError } = await supabase
      .from('saved_recipes')
      .select('id, title, image, source_url')
      .eq('source_url', testReelUrl)
      .single();

    if (testRecipe) {
      console.log('🎬 Found the test reel recipe:');
      console.log(`  Title: ${testRecipe.title}`);
      console.log(`  Image: ${testRecipe.image || 'NO IMAGE STORED'}`);

      if (testRecipe.image) {
        console.log('  ✅ This recipe DOES have an image URL in the database');

        // The issue might be in the frontend display then
        console.log('\n🔍 Since the image URL is stored correctly, the issue is likely:');
        console.log('  1. Frontend not loading the image properly');
        console.log('  2. Browser CORS/CSP blocking Instagram images');
        console.log('  3. Instagram CDN requiring specific headers/cookies');
        console.log('  4. CSS/styling issues hiding the image');
      } else {
        console.log('  ❌ This recipe has NO image URL - extraction/saving failed');
      }
    } else {
      console.log('🔍 Test reel recipe not found in database');
      if (testError && testError.code !== 'PGRST116') {
        console.log('Error:', testError);
      }
    }

  } catch (error) {
    console.error('💥 Test failed:', error);
  }
}

// Run the test
testDatabaseImages().catch(console.error);