// Input validation middleware for shortcuts

const validateShortcutImport = (req, res, next) => {
  const { url, token } = req.body;

  // Validate URL exists
  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing URL'
    });
  }

  // Validate URL format (any valid HTTP/HTTPS URL)
  try {
    const parsedUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid HTTP or HTTPS URL'
      });
    }
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid URL'
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
  // Determine source type from URL if not provided
  const sourceUrl = recipeData.source_url || recipeData.sourceUrl || '';
  const sourceType = recipeData.source_type ||
    (sourceUrl.includes('instagram.com') ? 'instagram' :
     sourceUrl.includes('facebook.com') || sourceUrl.includes('fb.watch') ? 'facebook' : 'web');

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
    source_type: sourceType,
    source_url: sourceUrl,
    source_author: String(recipeData.source_author || recipeData.sourceAuthor || '').substring(0, 255),
    source_author_image: String(recipeData.source_author_image || recipeData.sourceAuthorImage || ''),
    import_method: recipeData.import_method || 'ios_shortcut'
  };
};

module.exports = {
  validateShortcutImport,
  sanitizeRecipeData
};