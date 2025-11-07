const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getAnonClient, getServiceClient } = require('../config/supabase');

/**
 * @route   POST /api/support/feedback
 * @desc    Submit user feedback
 * @access  Protected (requires authentication)
 * @body    { message: string }
 */
router.post('/feedback', authenticateToken, async (req, res) => {
  // Use service client to bypass RLS - safe because JWT middleware already authenticated
  const supabase = getServiceClient();

  try {
    const { message } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;
    const userName = req.user.firstName || 'User';

    // Validation
    if (!message || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'Message is too long (max 5000 characters)'
      });
    }

    // Save feedback to database
    const { data, error } = await supabase
      .from('feedback_submissions')
      .insert([
        {
          user_id: userId,
          message: message.trim(),
          user_email: userEmail,
          user_name: userName,
          status: 'new'
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Error saving feedback:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to submit feedback'
      });
    }

    console.log(`[Support] New feedback submission from ${userName} (${userEmail}):`, message.substring(0, 100));

    // Optional: Send email notification if configured
    // This can be added later by importing an email service
    try {
      if (process.env.SUPPORT_EMAIL && process.env.EMAIL_ENABLED === 'true') {
        // Email notification will be added here
        // For now, just log that email would be sent
        console.log(`[Support] Email notification would be sent to ${process.env.SUPPORT_EMAIL}`);
      }
    } catch (emailError) {
      // Don't fail the request if email fails
      console.error('Email notification failed (non-critical):', emailError);
    }

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data: {
        id: data.id,
        created_at: data.created_at
      }
    });

  } catch (error) {
    console.error('Error in feedback submission:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * @route   GET /api/support/feedback
 * @desc    Get user's own feedback submissions
 * @access  Protected (requires authentication)
 */
router.get('/feedback', authenticateToken, async (req, res) => {
  // Use service client to bypass RLS - safe because JWT middleware already authenticated
  const supabase = getServiceClient();

  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('feedback_submissions')
      .select('id, message, status, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching feedback:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch feedback'
      });
    }

    res.json({
      success: true,
      data: data || []
    });

  } catch (error) {
    console.error('Error in feedback fetch:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;
