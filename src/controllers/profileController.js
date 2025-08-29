// controllers/profileController.js
const bcrypt = require('bcryptjs'); // used to hash a placeholder password for upsert insert
const User = require('../models/User');

/**
 * Utility: maps FE payload to the fields we store.
 * Mirror matchAlerts/newsUpdates into notifications.* for convenience.
 */

function sanitizeProfile(doc) {
    if (!doc) return doc;
    const { password, ...safe } = doc; // remove hashed password from API output
    return safe;
  }

function mapProfilePayload(body) {
  const {
    deviceId,
    name = '',
    email = '',
    phone = '',
    location = '',
    preferences = {},
  } = body;

  const matchAlerts = preferences.matchAlerts ?? true;
  const newsUpdates = preferences.newsUpdates ?? true;
  const emailNotifications = preferences.emailNotifications ?? false;

  // Build the $set document for updates
  const set = {
    deviceId,
    name,
    email,
    phone,
    location,
    'preferences.matchAlerts': !!matchAlerts,
    'preferences.newsUpdates': !!newsUpdates,
    'preferences.emailNotifications': !!emailNotifications,

    // keep  existing notifications map in sync 
    'preferences.notifications.score_updates': !!matchAlerts,
    'preferences.notifications.news': !!newsUpdates,
  };

  return set;
}

class ProfileController {
  /**
   * POST /api/profile
   * - Upsert by deviceId (fallback to email if deviceId missing)
   * - On first insert, sets a placeholder hashed password to satisfy schema
   * - Returns { success: true, profile }
   */
  async createProfile(req, res) {
    try {
      const { deviceId, email } = req.body || {};
      if (!deviceId && !email) {
        return res.status(400).json({
          success: false,
          message: 'deviceId or email is required to create a profile',
        });
      }

      const query = deviceId ? { deviceId } : { email };
      const set = mapProfilePayload(req.body);

      // FIRST INSERT ONLY, set a placeholder hashed password (schema requires password).
      // This does NOT affect any auth flow later; real auth can overwrite it.
      const placeholderHash = await bcrypt.hash('profile_placeholder_password', 10);

      const updated = await User.findOneAndUpdate(
        query,
        {
          $set: set,
          $setOnInsert: {
            // satisfy required fields on first insert
            password: placeholderHash,
            role: 'user',
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      ).lean();

      return res.status(200).json({
        success: true,
        // profile: updated,
        profile: sanitizeProfile(updated),
      });
    } catch (err) {
      // Handle duplicate key 
      if (err && err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'Duplicate key error (email or deviceId already exists)',
        });
      }
      console.error('Error in createProfile:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to create profile',
      });
    }
  }

  /**
   * PUT /api/profile
   * - Updates by deviceId (preferred). If deviceId missing, we fallback to email.
   * - Returns 404 if no profile found to update.
   * - Returns { success: true, profile }
   */
  async updateProfile(req, res) {
    try {
      const { deviceId, email } = req.body || {};
      if (!deviceId && !email) {
        return res.status(400).json({
          success: false,
          message: 'deviceId or email is required to update a profile',
        });
      }

      const query = deviceId ? { deviceId } : { email };
      const set = mapProfilePayload(req.body);

      const updated = await User.findOneAndUpdate(
        query,
        { $set: set },
        { new: true }
      ).lean();

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Profile not found for the given deviceId/email',
        });
      }

      return res.status(200).json({
        success: true,
        // profile: updated,
        profile: sanitizeProfile(updated),
      });
    } catch (err) {
      console.error('Error in updateProfile:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to update profile',
      });
    }
  }
   /** ---------------------------------------------------
   *  GET /api/profile/:deviceId
   * - Fetch a profile by deviceId 
   * - Returns 404 if not found
   * --------------------------------------------------- */
   async getProfile(req, res) {
    try {
      const { deviceId } = req.params;
      if (!deviceId) {
        return res.status(400).json({
          success: false,
          message: 'deviceId is required in URL (e.g. /api/profile/:deviceId)',
        });
      }

      const doc = await User.findOne({ deviceId }).lean();
      if (!doc) {
        return res.status(404).json({
          success: false,
          message: 'Profile not found',
        });
      }

      return res.status(200).json({
        success: true,
        profile: sanitizeProfile(doc),
      });
    } catch (err) {
      console.error('Error in getProfile:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch profile' });
    }
  }
}

module.exports = new ProfileController();
