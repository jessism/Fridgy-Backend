// Input validation middleware for shortcuts

const validateShortcutImport = (req, res, next) => {
  const { url, token } = req.body;
  
  // Validate URL
  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing URL'
    });
  }
  
  // Basic Instagram URL validation
  if (!url.includes('instagram.com')) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid Instagram URL'
    });
  }
  
  // Validate token format
  if (!token || typeof token !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing authentication token'
    });
  }
  
  // Token should start with our prefix
  const tokenPrefix = process.env.SHORTCUT_TOKEN_PREFIX || 'scut_';
  if (!token.startsWith(tokenPrefix)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid token format'
    });
  }
  
  // Sanitize inputs
  req.body.url = url.trim();
  req.body.token = token.trim();
  
  next();
};

const sanitizeRecipeData = (recipeData) => {
  // Ensure all required fields are present and properly typed
  return {
    title: String(recipeData.title || 'Untitled Recipe').substring(0, 255),
    summary: String(recipeData.summary || '').substring(0, 1000),
    image: String(recipeData.image || ''),
    extendedIngredients: Array.isArray(recipeData.extendedIngredients) 
      ? recipeData.extendedIngredients 
      : [],
    analyzedInstructions: Array.isArray(recipeData.analyzedInstructions) 
      ? recipeData.analyzedInstructions 
      : [],
    readyInMinutes: parseInt(recipeData.readyInMinutes) || null,
    servings: parseInt(recipeData.servings) || 4,
    vegetarian: Boolean(recipeData.vegetarian),
    vegan: Boolean(recipeData.vegan),
    glutenFree: Boolean(recipeData.glutenFree),
    dairyFree: Boolean(recipeData.dairyFree),
    // Add source metadata - using snake_case to match database columns
    source_type: 'instagram',
    source_url: recipeData.source_url || recipeData.sourceUrl,
    source_author: String(recipeData.source_author || recipeData.sourceAuthor || '').substring(0, 255),
    source_author_image: String(recipeData.source_author_image || recipeData.sourceAuthorImage || ''),
    import_method: 'ios_shortcut'
  };
};

module.exports = {
  validateShortcutImport,
  sanitizeRecipeData
};