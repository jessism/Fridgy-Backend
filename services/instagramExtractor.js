const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

class InstagramExtractor {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    this.rapidApiKey = process.env.RAPIDAPI_KEY;
    this.rapidApiHost = process.env.RAPIDAPI_HOST || 'instagram-scraper-api2.p.rapidapi.com';
  }

  async extractFromUrl(instagramUrl) {
    console.log(`[InstagramExtractor] Extracting from: ${instagramUrl}`);
    
    // Check cache first
    const cached = await this.checkCache(instagramUrl);
    if (cached) {
      console.log('[InstagramExtractor] Found in cache');
      return cached;
    }

    try {
      // For testing without API key, return mock data
      if (!this.rapidApiKey || this.rapidApiKey === 'your_key_here') {
        console.log('[InstagramExtractor] No API key configured, returning mock data for testing');
        return this.getMockData(instagramUrl);
      }

      // Use RapidAPI Instagram Scraper
      const response = await axios({
        method: 'GET',
        url: `https://${this.rapidApiHost}/v1/post_info`,
        params: { 
          code_or_id_or_url: instagramUrl 
        },
        headers: {
          'X-RapidAPI-Key': this.rapidApiKey,
          'X-RapidAPI-Host': this.rapidApiHost
        },
        timeout: 10000
      });

      const extractedData = this.parseInstagramResponse(response.data);
      
      // Cache the result
      await this.cacheResult(instagramUrl, extractedData);
      
      return extractedData;
    } catch (error) {
      console.error('[InstagramExtractor] Extraction error:', error.message);
      
      // Return partial data for manual processing
      return {
        success: false,
        url: instagramUrl,
        error: this.getErrorMessage(error),
        requiresManualInput: true,
        // Return mock data for development
        images: [],
        caption: '',
        author: { username: 'unknown' }
      };
    }
  }

  parseInstagramResponse(data) {
    const post = data.data || data;
    
    console.log('[InstagramExtractor] Parsing response:', {
      hasCaption: !!post.caption?.text,
      captionLength: post.caption?.text?.length,
      hasImages: !!(post.image_versions2 || post.carousel_media),
      username: post.user?.username
    });
    
    const result = {
      success: true,
      url: post.code ? `https://instagram.com/p/${post.code}` : null,
      
      // Media
      images: this.extractImages(post),
      videos: this.extractVideos(post),
      
      // Content - Try multiple caption sources
      caption: post.caption?.text || post.caption || '',
      hashtags: this.extractHashtags(post.caption?.text || post.caption),
      
      // Author
      author: {
        username: post.user?.username || 'unknown',
        fullName: post.user?.full_name,
        profilePic: post.user?.profile_pic_url,
        isVerified: post.user?.is_verified || false
      },
      
      // Metadata
      likes: post.like_count || 0,
      comments: post.comment_count || 0,
      timestamp: post.taken_at ? new Date(post.taken_at * 1000) : new Date(),
      location: post.location?.name,
      
      // Post type
      isCarousel: post.carousel_media ? true : false,
      isVideo: post.media_type === 2,
      isReel: post.product_type === 'clips'
    };
    
    console.log('[InstagramExtractor] Extracted caption preview:', result.caption?.substring(0, 100));
    
    return result;
  }

  extractImages(post) {
    const images = [];
    
    // Carousel posts (multiple images)
    if (post.carousel_media && Array.isArray(post.carousel_media)) {
      post.carousel_media.forEach(media => {
        if (media.image_versions2?.candidates) {
          // Get highest quality image
          const bestImage = media.image_versions2.candidates[0];
          images.push({
            url: bestImage.url,
            width: bestImage.width,
            height: bestImage.height
          });
        }
      });
    } 
    // Single image posts
    else if (post.image_versions2?.candidates) {
      const bestImage = post.image_versions2.candidates[0];
      images.push({
        url: bestImage.url,
        width: bestImage.width,
        height: bestImage.height
      });
    }
    
    return images;
  }

  extractVideos(post) {
    if (post.video_url) {
      return [{
        url: post.video_url,
        duration: post.video_duration,
        thumbnail: post.image_versions2?.candidates?.[0]?.url
      }];
    }
    return [];
  }

  extractHashtags(caption) {
    if (!caption) return [];
    const regex = /#[\w]+/g;
    const matches = caption.match(regex) || [];
    return matches.map(tag => tag.substring(1).toLowerCase());
  }

  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('instagram_cache')
        .select('data')
        .eq('url', url)
        .gt('expires_at', new Date().toISOString())
        .single();
      
      return data?.data || null;
    } catch (error) {
      // Cache miss or error
      return null;
    }
  }

  async cacheResult(url, data) {
    try {
      await this.supabase
        .from('instagram_cache')
        .upsert({
          url,
          data,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });
    } catch (error) {
      console.error('[InstagramExtractor] Cache error:', error.message);
      // Continue without caching
    }
  }

  getErrorMessage(error) {
    if (error.response?.status === 404) return 'Post not found or deleted';
    if (error.response?.status === 401) return 'Private account or authentication required';
    if (error.response?.status === 429) return 'Rate limit exceeded - please try again later';
    if (error.code === 'ECONNABORTED') return 'Request timeout - please try again';
    return 'Failed to extract content from Instagram';
  }

  // Mock data for testing without API key
  getMockData(url) {
    return {
      success: true,
      url: url,
      images: [{
        url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        width: 1080,
        height: 1080
      }],
      videos: [],
      caption: `🍝 Creamy Garlic Parmesan Pasta

INGREDIENTS:
• 1 lb fettuccine pasta
• 4 cloves garlic, minced
• 1 cup heavy cream
• 1 cup freshly grated Parmesan cheese
• 2 tbsp butter
• 2 tbsp olive oil
• Salt and pepper to taste
• Fresh parsley for garnish

INSTRUCTIONS:
1. Cook pasta according to package directions until al dente. Reserve 1 cup pasta water before draining.
2. In a large skillet, melt butter with olive oil over medium heat.
3. Add minced garlic and sauté for 1 minute until fragrant.
4. Pour in heavy cream and bring to a gentle simmer.
5. Add Parmesan cheese and stir until melted and smooth.
6. Add cooked pasta to the sauce and toss to combine.
7. Add pasta water as needed to reach desired consistency.
8. Season with salt and pepper.
9. Garnish with fresh parsley and extra Parmesan.

Ready in 20 minutes! Perfect for weeknight dinners 🌟

#pasta #italianfood #easyrecipes #dinnerideas #comfortfood #homecooking`,
      hashtags: ['pasta', 'italianfood', 'easyrecipes', 'dinnerideas', 'comfortfood', 'homecooking'],
      author: {
        username: 'testfoodblogger',
        fullName: 'Test Food Blogger',
        profilePic: 'https://ui-avatars.com/api/?name=Food+Blogger',
        isVerified: true
      },
      likes: 1234,
      comments: 56,
      timestamp: new Date(),
      location: null,
      isCarousel: false,
      isVideo: false,
      isReel: false
    };
  }
}

module.exports = InstagramExtractor;