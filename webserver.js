// webserver.js - Web interface for viewing and managing calls with optional authentication

require('dotenv').config();
const { loadConfig } = require('./src/config');
const { applyMigrations } = require('./src/db/migrations');
const { getJobSummary, getRecentJobs } = require('./src/jobs/processingJobs');
const {
  getSetupStatus,
  markSetupComplete,
  resolveSettings,
  saveSecret,
  saveSettings
} = require('./src/settings/settingsService');
const { runSetupChecks } = require('./src/setup/checks');
const AWS = require('aws-sdk'); // Add AWS SDK

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Environment variables
const {
  WEBSERVER_PORT,
  WEBSERVER_PASSWORD,
  PUBLIC_DOMAIN,
  TIMEZONE,
  ENABLE_AUTH, // New environment variable for toggling authentication
  SESSION_DURATION_DAYS = "7", // Default 7 days if not specified
  MAX_SESSIONS_PER_USER = "5", // Default 5 sessions if not specified
  GOOGLE_MAPS_API_KEY = null,
  // --- NEW: Geocoding API Keys ---
  LOCATIONIQ_API_KEY = null,
  // --- NEW: Storage Env Vars ---
  STORAGE_MODE = 'local', // Default to local if not set
  S3_ENDPOINT,
  S3_BUCKET_NAME,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  // --- NEW: AI Provider Env Vars ---
  AI_PROVIDER = 'ollama', // Can be 'ollama' or 'openai'
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini', // A good, fast, and cheap model for this task
  OLLAMA_URL = 'http://localhost:11434',
  OLLAMA_MODEL = 'llama3.1:8b'
} = process.env;

const startupConfig = loadConfig(process.env);
if (!startupConfig.isValid) {
  console.warn('WARNING: Configuration has issues. Setup mode will remain available:');
  for (const error of startupConfig.errors) {
    console.warn(`- ${error.key}: ${error.message}`);
  }
}

// Validate required environment variables
const requiredVars = ['WEBSERVER_PORT', 'PUBLIC_DOMAIN'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.warn(`WARNING: Missing environment variables: ${missingVars.join(', ')}. Setup mode will remain available.`);
}

// Check for at least one geocoding API key
if (!GOOGLE_MAPS_API_KEY && !LOCATIONIQ_API_KEY) {
  console.warn('WARNING: No geocoding API key configured yet. Use /setup to configure Google Maps or LocationIQ.');
}

// Log geocoding API availability
if (GOOGLE_MAPS_API_KEY) {
  console.log('[Webserver] Google Maps API key found - Google Places autocomplete will be available');
} else {
  console.log('[Webserver] Google Maps API key not found - Google Places autocomplete will be disabled');
}

if (LOCATIONIQ_API_KEY) {
  console.log('[Webserver] LocationIQ API key found - LocationIQ autocomplete will be available');
} else {
  console.log('[Webserver] LocationIQ API key not found - LocationIQ autocomplete will be disabled');
}

// Add endpoint to serve Google API key
const app = express();
app.use(express.json()); // Add this line to parse JSON bodies

app.get('/api/config/google-api-key', (req, res) => {
  res.json({ apiKey: GOOGLE_MAPS_API_KEY });
});

// Add endpoint to serve LocationIQ API key
app.get('/api/config/locationiq-api-key', (req, res) => {
  res.json({ apiKey: LOCATIONIQ_API_KEY });
});

// Add endpoint to serve all geocoding configuration
app.get('/api/config/geocoding', (req, res) => {
  res.json({
    google: {
      available: !!GOOGLE_MAPS_API_KEY,
      apiKey: GOOGLE_MAPS_API_KEY
    },
    locationiq: {
      available: !!LOCATIONIQ_API_KEY,
      apiKey: LOCATIONIQ_API_KEY
    }
  });
});

// Add endpoint to check if current user is admin
app.get('/api/auth/is-admin', async (req, res) => {
  if (!authEnabled) {
    return res.json({ isAdmin: false, authEnabled: false });
  }
  
  const authHeader = req.headers['authorization'];
  const adminStatus = await isAdminUser(authHeader);
  res.json({ isAdmin: adminStatus, authEnabled: true });
});

// Test endpoint to verify server is working
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working', timestamp: Date.now() });
});

// --- NEW: S3 Client Setup ---
let s3 = null;
if (STORAGE_MODE === 's3') {
  if (!S3_ENDPOINT || !S3_BUCKET_NAME || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    console.warn('WARNING: STORAGE_MODE=s3, but S3 configuration is incomplete. Audio serving from S3 will be unavailable until setup is completed.');
  } else {
    AWS.config.update({
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      endpoint: S3_ENDPOINT,
      s3ForcePathStyle: true, // Necessary for MinIO/non-AWS S3
      signatureVersion: 'v4'
    });
    s3 = new AWS.S3();
    console.log(`[Webserver] Storage mode set to S3. Endpoint: ${S3_ENDPOINT}, Bucket: ${S3_BUCKET_NAME}`);
  }
} else {
  console.log('[Webserver] Storage mode set to local.');
}

// Authentication is enabled if ENABLE_AUTH=true
const authEnabled = ENABLE_AUTH?.toLowerCase() === 'true';

// Session configuration (used only if auth is enabled)
const SESSION_DURATION = parseInt(SESSION_DURATION_DAYS, 10) * 24 * 60 * 60 * 1000; // Convert days to milliseconds
const MAX_SESSIONS = parseInt(MAX_SESSIONS_PER_USER, 10);
const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // Cleanup every hour

// Express app setup
const server = http.createServer(app);
const io = socketIo(server);

// Database setup
const db = new sqlite3.Database('./botdata.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

const dbReady = applyMigrations(db, { enableAuth: true })
  .then((applied) => {
    if (applied.length > 0) {
      console.log(`[Webserver] Applied migrations: ${applied.join(', ')}`);
    }
    return new Promise((resolve) => {
      db.run(`ALTER TABLE transcriptions ADD COLUMN category TEXT`, err => {
        if (!err || err.message.includes('duplicate column name')) {
          console.log('Category column exists or was created successfully');
        }
        resolve();
      });
    });
  })
  .catch((err) => {
    console.error('[Webserver] Error initializing database schema:', err);
  });

// Helper Functions for Authentication
function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Session Management Functions
async function createSession(userId, req) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION);
  const ipAddress = req.ip;
  const userAgent = req.get('user-agent');

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO sessions (user_id, token, expires_at, ip_address, user_agent) 
       VALUES (?, ?, datetime(?), ?, ?)`,
      [userId, token, expiresAt.toISOString(), ipAddress, userAgent],
      function(err) {
        if (err) reject(err);
        else resolve({ token, expiresAt });
      }
    );
  });
}

async function validateSession(token) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM sessions 
       WHERE token = ? AND expires_at > datetime('now')`,
      [token],
      (err, session) => {
        if (err) reject(err);
        else resolve(session);
      }
    );
  });
}

async function generateShortSummary(transcript) {
  try {
    // Original list of categories for the AI
    const categories = [
      'Medical Emergency', 'Injured Person', 'Disturbance', 'Vehicle Collision',
      'Burglary', 'Assault', 'Structure Fire', 'Missing Person', 'Medical Call',
      'Building Fire', 'Stolen Vehicle', 'Service Call', 'Vehicle Stop',
      'Unconscious Person', 'Reckless Driver', 'Person With A Gun',
      'Altered Level of Consciousness', 'Breathing Problems', 'Fight',
      'Carbon Monoxide', 'Abduction', 'Passed Out Person', 'Hazmat',
      'Fire Alarm', 'Traffic Hazard', 'Intoxicated Person', 'Mvc', // Note: Mvc is often redundant with Vehicle Collision
      'Animal Bite',
      'Assist'
    ];

    // This prompt works well for both Ollama and OpenAI's chat models
    const commonPrompt = `
You are an expert emergency service dispatcher categorizing radio transmissions.
Analyze the following first responder radio transmission and categorize it into EXACTLY ONE of the categories listed below.
Choose the category that best fits the main subject of the transmission.
Focus on the primary reason for the dispatch if multiple events are mentioned.

**PRIORITIZATION:**
- If a clear event type (like Vehicle Collision, Fire, Assault, Medical Emergency, etc.) is mentioned, **use that category even if the dispatcher says "no details"** or the information is minimal. do not add stars around your output such as "**GAS LEAK**".
- Use the 'Other' category ONLY if the transmission primarily contains just location/unit information OR if no specific event type from the list is mentioned at all.

It is CRUCIAL that your response is ONLY one of the category names from this list and nothing else.

Categories:
${categories.map(cat => `- ${cat}`).join('\n')}
- Other

Transmission: "${transcript}"

Category:`;

    let category = 'OTHER'; // Default value

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.warn(`[Webserver] AI request timed out after 10 seconds during categorization.`);
        controller.abort();
    }, 10000); // 10-second timeout

    // --- AI Provider Logic ---
    if (AI_PROVIDER.toLowerCase() === 'openai') {
        if (!OPENAI_API_KEY) {
            console.error('[Webserver] FATAL: AI_PROVIDER is set to openai, but OPENAI_API_KEY is not configured!');
            return 'OTHER'; // Fallback if key is missing
        }
        console.log(`[Webserver] Categorizing with OpenAI model: ${OPENAI_MODEL}`);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [{ role: 'user', content: commonPrompt }],
                temperature: 0.2, // Lower temp for more deterministic category
                max_tokens: 20    // A category name is short
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[Webserver] OpenAI API error! status: ${response.status}, transcript: ${transcript}, details: ${errorText}`);
          throw new Error(`OpenAI API error! status: ${response.status}`);
        }

        const result = await response.json();
        if (result.choices && result.choices.length > 0 && result.choices[0].message) {
            category = result.choices[0].message.content.trim();
        }

    } else { // Default to Ollama
        console.log(`[Webserver] Categorizing with Ollama model: ${OLLAMA_MODEL}`);

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: commonPrompt, // The prompt is compatible
            stream: false,
            options: {
                temperature: 0.3
            }
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.error(`[Webserver] Ollama API error! status: ${response.status} for transcript: ${transcript}`);
          throw new Error(`Ollama API error! status: ${response.status}`);
        }

        const result = await response.json();
        category = result.response.trim();
    }
    // --- End AI Provider Logic ---


    // The existing post-processing logic is generic enough to work for both
    const thinkBlockRegex = /<think>[\s\S]*?<\/think>\s*/;
    category = category.replace(thinkBlockRegex, '').trim().toUpperCase();

    // Validate the AI's response against the known categories (including OTHER)
    const validCategoriesUppercase = categories.map(cat => cat.toUpperCase());
    validCategoriesUppercase.push('OTHER');

    if (!validCategoriesUppercase.includes(category)) {
       console.warn(`[Webserver] AI returned an unexpected or invalid category: "${category}". Defaulting to OTHER for transcript: "${transcript}"`);
       category = 'OTHER';
    }
    
    return category;

  } catch (error) {
    console.error(`[Webserver] Error categorizing call: "${transcript}". Error: ${error.message}`);
    if (error.name === 'AbortError') {
         console.error(`[Webserver] AI request timed out during categorization: ${error.message}`);
    }
    return 'OTHER'; // Fallback to 'OTHER' in case of any errors
  }
}

function cleanupExpiredSessions() {
  if (authEnabled) {
    db.run('DELETE FROM sessions WHERE expires_at <= datetime("now")', [], (err) => {
      if (err) {
        console.error('Error cleaning up expired sessions:', err);
      } else {
        console.log('Expired sessions cleaned up');
      }
    });
  }
}

// Start session cleanup interval if auth enabled
if (authEnabled) {
  setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL);
}

// Authentication Middleware - only applied when authentication is enabled
const basicAuth = async (req, res, next) => {
  // Skip authentication if disabled in .env
  if (!authEnabled) {
    return next();
  }

  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      res.set('WWW-Authenticate', 'Basic realm="Protected Area"');
      return res.status(401).send('Authentication required.');
    }

    // Check if it's a Bearer token (session-based auth)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).send('Invalid Bearer token format.');
      }

      // Validate the session token
      const session = await validateSession(token);
      if (!session) {
        return res.status(401).send('Invalid or expired session token.');
      }

      // Get the user from the session
      const user = await new Promise((resolve, reject) => {
        db.get('SELECT id, username FROM users WHERE id = ?', [session.user_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!user) {
        return res.status(401).send('User not found for session.');
      }

      // Set user info in request for downstream use
      req.user = { id: user.id, username: user.username };
      req.session = session;
      return next();
    }

    // Check if it's Basic auth (username:password)
    if (authHeader.startsWith('Basic ')) {
      const base64Credentials = authHeader.split(' ')[1];
      if (!base64Credentials) {
        res.set('WWW-Authenticate', 'Basic realm="Protected Area"');
        return res.status(401).send('Invalid authentication format.');
      }

      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials.split(':');

      // Check credentials against database
      db.get(
        'SELECT id, password_hash, salt FROM users WHERE username = ?',
        [username],
        async (err, user) => {
          if (err) {
            console.error('Database error during authentication:', err);
            return res.status(500).send('Internal server error.');
          }

          if (!user) {
            res.set('WWW-Authenticate', 'Basic realm="Protected Area"');
            return res.status(401).send('Invalid credentials.');
          }

          const hashedPassword = hashPassword(password, user.salt);
          if (hashedPassword === user.password_hash) {
            // Get all active sessions for user, ordered by creation date
            db.all(
              `SELECT id, created_at, expires_at 
               FROM sessions 
               WHERE user_id = ? AND expires_at > datetime('now')
               ORDER BY created_at ASC`,
              [user.id],
              async (err, sessions) => {
                if (err) {
                  return res.status(500).send('Internal server error.');
                }

                // If at session limit, remove oldest session
                if (sessions.length >= MAX_SESSIONS) {
                  db.run(
                    'DELETE FROM sessions WHERE id = ?',
                    [sessions[0].id],
                    async (err) => {
                      if (err) {
                        console.error('Error removing oldest session:', err);
                        return res.status(500).send('Internal server error.');
                      }
                      console.log(`Removed oldest session for user ${username}`);
                      try {
                        const session = await createSession(user.id, req);
                        req.user = { id: user.id, username };
                        req.session = session;
                        next();
                      } catch (err) {
                        console.error('Error creating session:', err);
                        return res.status(500).send('Internal server error.');
                      }
                    }
                  );
                } else {
                  try {
                    const session = await createSession(user.id, req);
                    req.user = { id: user.id, username };
                    req.session = session;
                    next();
                  } catch (err) {
                    console.error('Error creating session:', err);
                    return res.status(500).send('Internal server error.');
                  }
                }
              }
            );
          } else {
            res.set('WWW-Authenticate', 'Basic realm="Protected Area"');
            return res.status(401).send('Invalid credentials.');
          }
        }
      );
    } else {
      return res.status(401).send('Unsupported authentication method. Use Basic or Bearer.');
    }
  } catch (err) {
    console.error('Authentication error:', err);
    return res.status(500).send('Internal server error.');
  }
};

// Admin Authentication Middleware
const adminAuth = (req, res, next) => {
  // Skip authentication if disabled in .env
  if (!authEnabled) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).send('Admin authentication required.');
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  if (username === 'admin' && password === WEBSERVER_PASSWORD) {
    next();
  } else {
    return res.status(401).send('Invalid admin credentials.');
  }
};

// Helper function to check if user is admin
async function isAdminUser(authHeader) {
  if (!authEnabled || !authHeader) {
    return false;
  }

  try {
    // Check if it's a Bearer token (session-based auth)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (!token) {
        return false;
      }

      // Validate the session token
      const session = await validateSession(token);
      if (!session) {
        return false;
      }

      // Get the user from the session
      const user = await new Promise((resolve, reject) => {
        db.get('SELECT username FROM users WHERE id = ?', [session.user_id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      // Check if the user is admin
      return user && user.username === 'admin';
    }

    // Check if it's Basic auth (username:password)
    if (authHeader.startsWith('Basic ')) {
      const base64Credentials = authHeader.split(' ')[1];
      if (!base64Credentials) {
        return false;
      }

      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials.split(':');

      return username === 'admin' && password === WEBSERVER_PASSWORD;
    }

    return false;
  } catch (error) {
    console.error('Error in isAdminUser:', error);
    return false;
  }
}

// --- NEW HELPER FUNCTION ---
// Store the last purge operation details for undo functionality
let lastPurgeDetails = null;

// Function to store original coordinates before purging
async function storeOriginalCoordinates(talkgroupIds, categories, timeRangeStart, timeRangeEnd) {
  return new Promise((resolve, reject) => {
    // Build the WHERE clause to get calls that will be purged
    let whereConditions = ['lat IS NOT NULL AND lon IS NOT NULL'];
    let params = [];

    // If no talkgroups selected, it means "all talkgroups" (no filter applied)
    if (talkgroupIds && talkgroupIds.length > 0) {
      whereConditions.push(`talk_group_id IN (${talkgroupIds.map(() => '?').join(',')})`);
      params.push(...talkgroupIds);
    }
    // If no talkgroups selected, don't add any filter - this means "all talkgroups"

    if (categories && categories.length > 0) {
      whereConditions.push(`UPPER(category) IN (${categories.map(() => 'UPPER(?)').join(',')})`);
      params.push(...categories);
    }

    whereConditions.push('timestamp BETWEEN ? AND ?');
    params.push(timeRangeStart, timeRangeEnd);

    const whereClause = whereConditions.join(' AND ');
    const selectQuery = `SELECT id, lat, lon FROM transcriptions WHERE ${whereClause}`;

    db.all(selectQuery, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function serveAudioFromDb(res, transcriptionId) {
    console.log(`[Audio DB] Serving audio for ID ${transcriptionId} from database blob.`);
    try {
        const audioRow = await new Promise((resolve, reject) => {
            db.get('SELECT audio_data FROM audio_files WHERE transcription_id = ?', [transcriptionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (audioRow && audioRow.audio_data) {
            const pathRow = await new Promise((resolve, reject) => {
                 db.get('SELECT audio_file_path FROM transcriptions WHERE id = ?', [transcriptionId], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });

            const filePath = pathRow ? pathRow.audio_file_path : '';
            const extension = path.extname(filePath).toLowerCase();
            const contentType = extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
            
            res.setHeader('Content-Type', contentType);
            res.send(audioRow.audio_data);
        } else {
            console.error(`[Audio DB] Audio data not found in DB for ID: ${transcriptionId}`);
            if (!res.headersSent) {
                res.status(404).send('Audio not found in any storage location.');
            }
        }
    } catch (dbErr) {
        console.error(`[Audio DB] DB error for ID ${transcriptionId}:`, dbErr);
        if (!res.headersSent) {
            res.status(500).send('Internal Server Error during DB fallback.');
        }
    }
}

// Public Routes (No Auth Required)
app.get('/audio/:id', async (req, res) => {
  const transcriptionId = req.params.id;
  
  try {
    const transcriptionRow = await new Promise((resolve, reject) => {
        db.get('SELECT audio_file_path FROM transcriptions WHERE id = ?', [transcriptionId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    if (transcriptionRow && transcriptionRow.audio_file_path) {
        const audioStoragePath = transcriptionRow.audio_file_path;
        const extension = path.extname(audioStoragePath).toLowerCase();
        const contentType = extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';

        if (STORAGE_MODE === 's3') {
            const params = { Bucket: S3_BUCKET_NAME, Key: audioStoragePath };
            const s3Stream = s3.getObject(params).createReadStream();
            s3Stream.on('error', (s3Err) => {
                console.warn(`[Audio S3] S3 stream error for key ${audioStoragePath}: ${s3Err.code}. Falling back to DB.`);
                serveAudioFromDb(res, transcriptionId);
            });
            res.setHeader('Content-Type', contentType);
            s3Stream.pipe(res);
            return; 
        } else { // Local storage
            const localPath = path.join(__dirname, 'audio', audioStoragePath);
            if (fs.existsSync(localPath)) {
                res.setHeader('Content-Type', contentType);
                fs.createReadStream(localPath).pipe(res);
                return;
            } else {
                 console.warn(`[Audio Local] File not found at ${localPath}. Falling back to DB.`);
            }
        }
    }
    
    // Fallback to serving from the database blob if file not found or path missing.
    serveAudioFromDb(res, transcriptionId);

  } catch (dbErr) {
    console.error('[Audio Request] Database error:', dbErr);
    return res.status(500).send('Internal Server Error');
  }
});

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/settings', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/api/setup/status', async (req, res) => {
  await dbReady;
  try {
    const status = await getSetupStatus(db, process.env);
    res.json(status);
  } catch (err) {
    console.error('Error fetching setup status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/setup/checks', async (req, res) => {
  await dbReady;
  try {
    const checks = await runSetupChecks({ rootDir: __dirname, env: process.env });
    res.json(checks);
  } catch (err) {
    console.error('Error running setup checks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/admin', async (req, res) => {
  await dbReady;
  const { username = 'admin', password } = req.body || {};
  if (username !== 'admin') {
    return res.status(400).json({ error: 'The first setup user must be admin.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
  }

  try {
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => err ? reject(err) : resolve(row));
    });
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    if (existing) {
      db.run('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?', [passwordHash, salt, 'admin'], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update admin user' });
        res.json({ ok: true, updated: true });
      });
    } else {
      db.run('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)', ['admin', passwordHash, salt], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to create admin user' });
        res.json({ ok: true, created: true });
      });
    }
  } catch (err) {
    console.error('Error creating setup admin:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/settings', async (req, res) => {
  await dbReady;
  try {
    const result = await saveSettings(db, req.body || {}, 'setup');
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Error saving setup settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/secrets', async (req, res) => {
  await dbReady;
  const { key, value } = req.body || {};
  try {
    const result = await saveSecret(db, key, value, { actor: 'setup', env: process.env });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('Error saving setup secret:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/test-provider', async (req, res) => {
  await dbReady;
  const { provider } = req.body || {};
  try {
    const checks = await runSetupChecks({ rootDir: __dirname, env: process.env });
    const providerMap = {
      geocoding: checks.geocodingProvider,
      transcription: checks.transcriptionProvider,
      ai: checks.aiProvider,
      storage: checks.dataDir,
      upload: checks.uploadEndpoint
    };
    res.json(providerMap[provider] || { ok: false, error: 'Unknown provider test' });
  } catch (err) {
    console.error('Error testing provider:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/complete', async (req, res) => {
  await dbReady;
  try {
    const status = await getSetupStatus(db, process.env);
    if (status.missing.length > 0) {
      return res.status(400).json({ error: 'Setup is incomplete', missing: status.missing });
    }
    await markSetupComplete(db, 'setup');
    res.json({ ok: true, setupComplete: true });
  } catch (err) {
    console.error('Error completing setup:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Apply authentication middleware to protected routes if auth is enabled
app.use(basicAuth);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Session Management Routes (Only relevant when auth is enabled)
app.get('/api/sessions/current', (req, res) => {
  if (authEnabled) {
    res.json({
      session: req.session || null,
      user: req.user || null
    });
  } else {
    res.json({
      session: { token: 'anonymous-session' },
      user: { username: 'anonymous' }
    });
  }
});

app.get('/api/sessions', adminAuth, (req, res) => {
  if (!authEnabled) {
    return res.json([]);
  }

  const userId = req.query.userId;
  let query = `
    SELECT s.*, u.username, s.ip_address, s.user_agent
    FROM sessions s 
    JOIN users u ON s.user_id = u.id 
    WHERE s.expires_at > datetime('now')
  `;
  const params = [];

  if (userId && userId !== 'all') {
    query += ' AND s.user_id = ?';
    params.push(userId);
  }

  query += ' ORDER BY s.created_at DESC';

  db.all(query, params, (err, sessions) => {
    if (err) {
      console.error('Error fetching sessions:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json(sessions);
  });
});

app.delete('/api/sessions/:token', adminAuth, (req, res) => {
  if (!authEnabled) {
    return res.json({ message: 'Authentication is disabled' });
  }

  db.run(
    'DELETE FROM sessions WHERE token = ?',
    [req.params.token],
    function(err) {
      if (err) {
        console.error('Error deleting session:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ message: 'Session terminated successfully' });
    }
  );
});

app.get('/api/sessions/me', (req, res) => {
  if (!authEnabled) {
    return res.json([]);
  }

  db.all(
    `SELECT id, created_at, expires_at, ip_address, user_agent 
     FROM sessions 
     WHERE user_id = ? AND expires_at > datetime('now')
     ORDER BY created_at DESC`,
    [req.user.id],
    (err, sessions) => {
      if (err) {
        console.error('Error fetching user sessions:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json(sessions);
    }
  );
});

// Processing Job Diagnostics Routes (Admin Only when auth is enabled)
app.get('/api/jobs/summary', adminAuth, async (req, res) => {
  try {
    const summary = await getJobSummary(db);
    res.json(summary);
  } catch (err) {
    console.error('Error fetching job summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/jobs/recent', adminAuth, async (req, res) => {
  try {
    const jobs = await getRecentJobs(db, {
      limit: req.query.limit,
      status: req.query.status,
      jobType: req.query.jobType
    });
    res.json(jobs);
  } catch (err) {
    console.error('Error fetching recent jobs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/settings', adminAuth, async (req, res) => {
  await dbReady;
  try {
    const settings = await resolveSettings(db, process.env);
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/settings', adminAuth, async (req, res) => {
  await dbReady;
  try {
    const result = await saveSettings(db, req.body || {}, req.user?.username || 'admin');
    const requiresRestart = Object.values(result).some((item) => item.requiresRestart);
    res.json({ ok: true, result, requiresRestart });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/settings/secrets/:key', adminAuth, async (req, res) => {
  await dbReady;
  try {
    const result = await saveSecret(db, req.params.key, req.body?.value, {
      actor: req.user?.username || 'admin',
      env: process.env
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('Error updating secret:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/settings/checks', adminAuth, async (req, res) => {
  await dbReady;
  try {
    const checks = await runSetupChecks({ rootDir: __dirname, env: process.env });
    res.json(checks);
  } catch (err) {
    console.error('Error running settings checks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User Management Routes (Admin Only when auth is enabled)
app.post('/api/users', adminAuth, async (req, res) => {
  if (!authEnabled) {
    return res.status(400).json({ error: 'Authentication is disabled' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  try {
    const result = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)',
        [username, passwordHash, salt],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    res.status(201).json({ 
      message: 'User created successfully',
      userId: result
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Username already exists.' });
    } else {
      console.error('Error creating user:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
});

app.get('/api/users', adminAuth, (req, res) => {
  if (!authEnabled) {
    return res.json([]);
  }

  db.all(
    `SELECT u.id, u.username, u.created_at,
            COUNT(s.id) as active_sessions
     FROM users u
     LEFT JOIN sessions s ON u.id = s.user_id 
        AND s.expires_at > datetime('now')
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [],
    (err, users) => {
      if (err) {
        console.error('Error fetching users:', err);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      res.json(users);
    }
  );
});

app.delete('/api/users/:id', adminAuth, (req, res) => {
  if (!authEnabled) {
    return res.status(400).json({ error: 'Authentication is disabled' });
  }

  const userId = parseInt(req.params.id, 10);
  
  if (isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID.' });
  }

  db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
    if (err) {
      console.error('Error deleting user:', err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    res.json({ message: 'User deleted successfully.' });
  });
});

// API Routes for call data
app.get('/api/calls', (req, res) => {
  const hours = parseInt(req.query.hours) || 12;
  // Convert hours to a Unix timestamp (seconds) for the WHERE clause
  const sinceTimestampUnix = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

  console.log(`Fetching calls since Unix timestamp: ${sinceTimestampUnix} (${hours} hours ago)`);

  db.all(
    `
    SELECT t.*, tg.alpha_tag AS talk_group_name, tg.tag AS talk_group_tag
    FROM transcriptions t
    LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
    WHERE t.timestamp >= ? AND t.lat IS NOT NULL AND t.lon IS NOT NULL
    ORDER BY t.timestamp DESC
    `,
    [sinceTimestampUnix], // Use Unix timestamp for the query
    (err, rows) => {
      if (err) {
        console.error('Error fetching calls:', err);
        res.status(500).json({ error: err.message });
        return;
      }

      console.log(`Returning ${rows.length} calls`);
      // Timestamps are now already Unix seconds from the DB
      if (rows.length > 0) {
        console.log(`Oldest call in result (Unix ts): ${rows[rows.length - 1].timestamp}`);
        console.log(`Newest call in result (Unix ts): ${rows[0].timestamp}`);
      }
      res.json(rows); // Send rows directly as timestamps are already numeric
    }
  );
});

app.delete('/api/markers/:id', (req, res) => {
  const markerId = parseInt(req.params.id, 10);

  if (isNaN(markerId)) {
    return res.status(400).json({ error: 'Invalid marker ID' });
  }

  db.run(
    'DELETE FROM transcriptions WHERE id = ?',
    [markerId],
    function(err) {
      if (err) {
        console.error('Error deleting marker:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.json({ message: 'Marker deleted successfully' });
    }
  );
});

app.put('/api/markers/:id/location', (req, res) => {
  const markerId = parseInt(req.params.id);
  const { lat, lon } = req.body;

  if (isNaN(markerId) || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  db.run(
    'UPDATE transcriptions SET lat = ?, lon = ? WHERE id = ?',
    [lat, lon, markerId],
    function(err) {
      if (err) {
        console.error('Error updating marker location:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ success: true });
    }
  );
});

app.get('/api/additional-transcriptions/:callId', (req, res) => {
  const callId = parseInt(req.params.callId, 10);
  const skip = parseInt(req.query.skip, 10) || 0;

  if (isNaN(callId)) {
    return res.status(400).send('Invalid call ID.');
  }

  db.get(
    'SELECT talk_group_id FROM transcriptions WHERE id = ?',
    [callId],
    (err, row) => {
      if (err) {
        console.error('Error fetching talk group ID:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Call not found' });
      }

      const talkGroupId = row.talk_group_id;

      db.all(
        `
        SELECT t.id, t.transcription, t.audio_file_path, t.timestamp, tg.alpha_tag AS talk_group_name
        FROM transcriptions t
        LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
        WHERE t.talk_group_id = ? AND t.id > ?
        ORDER BY t.id ASC
        LIMIT 3 OFFSET ?
        `,
        [talkGroupId, callId, skip],
        (err, rows) => {
          if (err) {
            console.error('Error fetching additional transcriptions:', err);
            return res.status(500).json({ error: 'Internal Server Error' });
          }
          // ADD LOGGING HERE
          console.log(`[/api/additional-transcriptions] Responding with ${rows.length} rows. First row ID: ${rows.length > 0 ? rows[0].id : 'N/A'}`);
          res.json(rows);
        }
      );
    }
  );
});

// NEW Endpoint for Talkgroup History
app.get('/api/talkgroup/:talkgroupId/calls', (req, res) => {
  const talkgroupId = parseInt(req.params.talkgroupId, 10);
  const sinceId = parseInt(req.query.sinceId, 10) || 0; // For polling
  const limit = parseInt(req.query.limit, 10) || 30; // Default limit 30
  const offset = parseInt(req.query.offset, 10) || 0; // Default offset 0

  if (isNaN(talkgroupId)) {
    return res.status(400).json({ error: 'Invalid talkgroup ID' });
  }

  let query;
  const params = [];

  if (sinceId > 0) {
    // Polling request: Get calls strictly newer than the last known ID (limit doesn't apply here)
    console.log(`Polling calls for talkgroup ${talkgroupId} since ID: ${sinceId}`);
    query = `
      SELECT t.id, t.transcription, t.timestamp, tg.alpha_tag AS talk_group_name
      FROM transcriptions t
      LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
      WHERE t.talk_group_id = ? AND t.id > ?
        AND t.transcription IS NOT NULL
      ORDER BY t.id ASC -- Fetch oldest first when polling since ID 
    `;
    params.push(talkgroupId, sinceId);
  } else {
    // Initial load or subsequent page request: Use LIMIT and OFFSET
    console.log(`Fetching calls for talkgroup ${talkgroupId} with limit: ${limit}, offset: ${offset}`);
    query = `
      SELECT t.id, t.transcription, t.timestamp, tg.alpha_tag AS talk_group_name
      FROM transcriptions t
      LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
      WHERE t.talk_group_id = ? 
        AND t.transcription IS NOT NULL
      ORDER BY t.timestamp DESC -- Show newest first overall
      LIMIT ? OFFSET ?
    `;
    params.push(talkgroupId, limit, offset);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error(`Error fetching calls for talkgroup ${talkgroupId}:`, err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (sinceId > 0) {
       console.log(`Poll returned ${rows.length} calls for talkgroup ${talkgroupId} since ID ${sinceId}`); 
    } else {
       console.log(`Paginated load returned ${rows.length} calls for talkgroup ${talkgroupId}`);
    }
    res.json(rows);
  });
});
// END NEW Endpoint

// NEW Endpoint to get details for a single call (for live feed retries)
app.get('/api/call/:id/details', (req, res) => {
  const callId = parseInt(req.params.id, 10);

  if (isNaN(callId)) {
    return res.status(400).json({ error: 'Invalid call ID' });
  }

  db.get(
    `
    SELECT t.id, t.transcription, t.timestamp, t.talk_group_id, tg.alpha_tag AS talk_group_name
    FROM transcriptions t
    LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
    WHERE t.id = ?
    `,
    [callId],
    (err, row) => {
      if (err) {
        console.error(`Error fetching details for call ${callId}:`, err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Call not found' });
      }
      // console.log(`[API Call Details] Returning details for ID: ${callId}`); // Optional: verbose log
      res.json(row);
    }
  );
});

// Socket.IO Setup
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// --- Start Polling Logic --- 

// State variables for polling
let lastCallId = 0; // For map updates
let lastLiveFeedCallId = 0; // For live feed updates

// Initialization functions
function initializeLastCallId() {
  db.get('SELECT MAX(id) AS maxId FROM transcriptions', (err, row) => {
    if (err) {
      console.error('Error initializing lastCallId:', err.message);
    } else {
      lastCallId = row.maxId || 0;
      console.log(`Initialized lastCallId (for map) to ${lastCallId}`);
    }
  });
}

function initializeLastLiveFeedCallId() {
  db.get('SELECT MAX(id) AS maxId FROM transcriptions', (err, row) => {
    if (err) {
      console.error('Error initializing lastLiveFeedCallId:', err.message);
    } else {
      lastLiveFeedCallId = row.maxId || 0;
      console.log(`Initialized lastLiveFeedCallId (for feed) to ${lastLiveFeedCallId}`);
    }
  });
}


// Polling function for MAP updates (requires lat/lon)
function checkForNewCalls() {
  db.all(
    `
    SELECT t.*, tg.alpha_tag AS talk_group_name, tg.tag AS talk_group_tag
    FROM transcriptions t
    LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
    WHERE t.id > ? 
      AND t.lat IS NOT NULL
      AND t.lon IS NOT NULL
      AND t.lat BETWEEN -90 AND 90 
      AND t.lon BETWEEN -180 AND 180
    ORDER BY t.id ASC
    LIMIT 10 -- Limit to prevent flooding
    `,
    [lastCallId],
    async (err, rows) => {
      if (err) {
        console.error('Error checking for new map calls:', err.message);
        return;
      }
      
      let updatedLastId = lastCallId;
      if (rows && rows.length > 0) {
          for (const row of rows) {
              if (row.id > updatedLastId) {
                  updatedLastId = row.id; // Track highest ID fetched
              }

              // --- Process Category --- 
              if (!row.category && row.transcription) {
                  try {
                      const category = await generateShortSummary(row.transcription);
                      if (category) {
                          console.log(`Generated category for map call ID ${row.id}: "${category}"`);
                          await new Promise((resolve, reject) => {
                              db.run(
                                  `UPDATE transcriptions SET category = ? WHERE id = ?`,
                                  [category, row.id],
                                  function(dbErr) {
                                      if (dbErr) reject(dbErr);
                                      else resolve();
                                  }
                              );
                          });
                          row.category = category;
                      }
                  } catch (categoryError) {
                      console.error(`Error generating category for map call ID ${row.id}:`, categoryError);
                  }
              }
              // --- End Category Processing ---

              // Timestamp from DB is now Unix seconds
              // const numericTimestamp = Math.floor(new Date(row.timestamp).getTime() / 1000);
              // if (isNaN(numericTimestamp)) {
              //  console.error(`Invalid timestamp in polling (newCall): ${row.timestamp} for call ID ${row.id}`);
              //  continue; // Skip this row
              // }
              // const processedRow = { ...row, timestamp: numericTimestamp };

              // --- Emission Logic with Timeout --- 
              if (row.transcription) {
                   // Has transcription, emit immediately
                  io.emit('newCall', row); // row.timestamp is already Unix seconds
              } else {
                  // No transcription yet, check age
                  // row.timestamp is Unix seconds, multiply by 1000 for JS Date
                  const callAgeMs = Date.now() - (row.timestamp * 1000);
                  if (callAgeMs > 10000) { // 10 second timeout
                      // Timeout exceeded, emit with placeholder
                      const rowWithPlaceholder = { ...row, transcription: "[Transcription Pending...]" };
                      io.emit('newCall', rowWithPlaceholder);
                  } else {
                      // Too new and no transcription, wait 
                  }
              }
              // --- End Emission Logic ---
          }
          // Update state variable *after* processing batch with highest ID *fetched*
          if (updatedLastId > lastCallId) {
              lastCallId = updatedLastId;
          }
      }
    }
  );
}

// Polling function specifically for the LIVE FEED (no location check)
function checkForLiveFeedCalls() {
  db.all(
    `
    SELECT t.id, t.talk_group_id, t.transcription, t.timestamp,
           t.audio_file_path, -- Added audio_file_path for potential use
           tg.alpha_tag AS talk_group_name
    FROM transcriptions t
    LEFT JOIN talk_groups tg ON t.talk_group_id = tg.id
    WHERE t.id > ? 
    ORDER BY t.id ASC
    LIMIT 10 -- Limit to prevent flooding
    `,
    [lastLiveFeedCallId],
    (err, rows) => {
      if (err) {
        console.error('Error checking for live feed calls:', err.message);
        return;
      }
      
      let highestEmittedId = lastLiveFeedCallId; // Track the highest ID we ACTUALLY emit

      if (rows && rows.length > 0) {
          rows.forEach(row => {
              // Timestamp from DB is now Unix seconds
              // const numericTimestamp = Math.floor(new Date(row.timestamp).getTime() / 1000);
              // if (isNaN(numericTimestamp)) {
              //  console.error(`Invalid timestamp in polling (liveFeedUpdate): ${row.timestamp} for call ID ${row.id}`);
              //  return; // Skip this iteration of forEach
              // }
              // const processedRow = { ...row, timestamp: numericTimestamp };

              let shouldEmit = false;
              // --- Emission Logic with Timeout ---
              if (row.transcription) {
                   // Has transcription, emit immediately
                   shouldEmit = true;
              } else {
                   // No transcription yet, check age
                   // row.timestamp is Unix seconds, multiply by 1000 for JS Date
                  const callAgeMs = Date.now() - (row.timestamp * 1000);
                  if (callAgeMs > 10000) { // 10 second timeout
                      // Timeout exceeded, emit with placeholder
                      // Create a new object for the row with placeholder to avoid modifying original row in loop
                      // const rowWithPlaceholder = { ...row, transcription: "[Transcription Pending...]" };
                      // io.emit('liveFeedUpdate', rowWithPlaceholder);
                      // shouldEmit = true; // This was incorrect, emission is handled below
                      row.transcription = "[Transcription Pending...]"; // Modify row for this emission
                      shouldEmit = true;
                  } else {
                      // Too new and no transcription, wait (DO NOTHING)
                  }
              }
              // --- End Emission Logic ---
              
              // Emit only if decided
              if (shouldEmit) {
                 io.emit('liveFeedUpdate', row); // row.timestamp is already Unix seconds
                 // Update highestEmittedId only when we actually emit
                 if (row.id > highestEmittedId) {
                    highestEmittedId = row.id;
                 }
              }
          });

          // Update state variable *after* processing batch using the highest EMITTED ID
          if (highestEmittedId > lastLiveFeedCallId) {
              lastLiveFeedCallId = highestEmittedId;
          }
      }
    }
  );
}

// Initialize last IDs and start polling intervals
initializeLastCallId();
initializeLastLiveFeedCallId();
setInterval(checkForNewCalls, 2000); // Poll for map updates every 2s
setInterval(checkForLiveFeedCalls, 2500); // Poll for live feed slightly offset, every 2.5s

// --- End Polling Logic ---

// Server Startup
server.listen(WEBSERVER_PORT, () => {
  console.log(`Web server running on port ${WEBSERVER_PORT}`);
  console.log(`Audio URL base: http://${PUBLIC_DOMAIN}:${WEBSERVER_PORT}/audio/`);
  
  if (authEnabled) {
    console.log('Authentication: ENABLED');
    console.log(`Session duration: ${SESSION_DURATION / (24 * 60 * 60 * 1000)} days`);
    console.log(`Max sessions per user: ${MAX_SESSIONS}`);
  } else {
    console.log('Authentication: DISABLED');
  }
});

// Add correction logging endpoint
app.post('/api/log/correction', (req, res) => {
  const { callId, originalAddress, newAddress } = req.body;

  if (!callId || !originalAddress || !newAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const logData = {
    timestamp: new Date().toISOString(),
    callId,
    originalAddress,
    newAddress
  };

  const logFilePath = path.join(logsDir, `corrections_${new Date().toISOString().split('T')[0]}.json`);
  
  // Read existing logs
  let existingLogs = [];
  if (fs.existsSync(logFilePath)) {
    try {
      const fileContent = fs.readFileSync(logFilePath, 'utf8');
      existingLogs = JSON.parse(fileContent);
    } catch (err) {
      console.error('Error reading log file:', err);
    }
  }

  // Add new log entry
  existingLogs.push(logData);

  // Write back to file
  fs.writeFile(logFilePath, JSON.stringify(existingLogs, null, 2), (err) => {
    if (err) {
      console.error('Error writing to log file:', err);
      return res.status(500).json({ error: 'Failed to write to log' });
    }
    res.json({ success: true });
  });
});

// NEW Endpoint for logging deletions
app.post('/api/log/deletion', (req, res) => {
  const { callId, category, transcription, location, address, action } = req.body;

  // Basic validation - check for essential fields
  if (!callId || action !== 'marker_deletion') {
    return res.status(400).json({ error: 'Missing required fields for deletion log' });
  }

  const logData = {
    timestamp: new Date().toISOString(),
    callId,
    category: category || 'UNKNOWN',
    transcription: transcription || 'N/A',
    location: location || null,
    address: address || 'N/A',
    action
  };

  const logFilePath = path.join(logsDir, `deletions_${new Date().toISOString().split('T')[0]}.json`);

  // Read existing logs for deletions
  let existingLogs = [];
  if (fs.existsSync(logFilePath)) {
    try {
      const fileContent = fs.readFileSync(logFilePath, 'utf8');
      if (fileContent) { // Check if file is not empty
           existingLogs = JSON.parse(fileContent);
           if (!Array.isArray(existingLogs)) { // Ensure it's an array
               console.warn('Deletion log file was not an array, resetting.');
               existingLogs = [];
           }
       } else {
           existingLogs = [];
       }
    } catch (err) {
      console.error('Error reading deletion log file:', err);
      existingLogs = []; // Reset if reading fails
    }
  }

  // Add new log entry
  existingLogs.push(logData);

  // Write back to file
  fs.writeFile(logFilePath, JSON.stringify(existingLogs, null, 2), (err) => {
    if (err) {
      console.error('Error writing to deletion log file:', err);
      // Still return success to client, as the main operation (deletion) likely succeeded
      // but log the server-side error.
      return res.status(500).json({ error: 'Failed to write to deletion log' });
    }
    console.log(`Deletion logged successfully for callId: ${callId}`);
    res.json({ success: true, message: 'Deletion logged.' });
  });
});

// Get all talkgroups for selection UI
app.get('/api/talkgroups', (req, res) => {
  db.all(
    `SELECT id, alpha_tag, tag 
     FROM talk_groups 
     ORDER BY alpha_tag ASC`, // Order alphabetically for easier browsing
    [], 
    (err, rows) => {
      if (err) {
        console.error('Error fetching talkgroups:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      // Combine alpha_tag and tag for display if alpha_tag exists
      const talkgroups = rows.map(tg => ({
        id: tg.id,
        name: tg.alpha_tag ? `${tg.alpha_tag} (${tg.tag || tg.id})` : (tg.tag || `ID: ${tg.id}`)
      }));
      res.json(talkgroups);
    }
  );
});

// Get all available categories for selection UI
app.get('/api/categories', (req, res) => {
  const categories = [
    'Medical Emergency', 'Injured Person', 'Disturbance', 'Vehicle Collision',
    'Burglary', 'Assault', 'Structure Fire', 'Missing Person', 'Medical Call',
    'Building Fire', 'Stolen Vehicle', 'Service Call', 'Vehicle Stop',
    'Unconscious Person', 'Reckless Driver', 'Person With A Gun',
    'Altered Level of Consciousness', 'Breathing Problems', 'Fight',
    'Carbon Monoxide', 'Abduction', 'Passed Out Person', 'Hazmat',
    'Fire Alarm', 'Traffic Hazard', 'Intoxicated Person', 'Mvc',
    'Animal Bite', 'Assist', 'Other'
  ];
  
  res.json(categories);
});

// Get count of calls that would be purged (Admin Only when auth is enabled)
app.get('/api/calls/purge-count', async (req, res) => {
  // Check authentication if enabled
  if (ENABLE_AUTH?.toLowerCase() === 'true') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !(await isAdminUser(authHeader))) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  // Parse query parameters - handle both array and single values
  const talkgroupIds = req.query.talkgroupIds ? 
    (Array.isArray(req.query.talkgroupIds) ? req.query.talkgroupIds : [req.query.talkgroupIds]) : [];
  const categories = req.query.categories ? 
    (Array.isArray(req.query.categories) ? req.query.categories : [req.query.categories]) : [];
  
  // Handle timeRange parameters from query string
  const timeRangeStart = req.query.timeRangeStart;
  const timeRangeEnd = req.query.timeRangeEnd;

  // Validate input
  if (!timeRangeStart || !timeRangeEnd) {
    return res.status(400).json({ error: 'Time range is required' });
  }

  // Build the WHERE clause dynamically
  let whereConditions = ['lat IS NOT NULL AND lon IS NOT NULL']; // Only count calls that have coordinates
  let params = [];

  // Add talkgroup filter if specified
  if (talkgroupIds.length > 0) {
    whereConditions.push(`talk_group_id IN (${talkgroupIds.map(() => '?').join(',')})`);
    params.push(...talkgroupIds);
  }

  // Add category filter if specified
  if (categories.length > 0) {
    // Use UPPER() to make case-insensitive comparison
    whereConditions.push(`UPPER(category) IN (${categories.map(() => 'UPPER(?)').join(',')})`);
    params.push(...categories);
  }

  // Add time range filter
  whereConditions.push('timestamp BETWEEN ? AND ?');
  const startTime = parseInt(timeRangeStart);
  const endTime = parseInt(timeRangeEnd);
  
  // Validate parsed timestamps
  if (isNaN(startTime) || isNaN(endTime)) {
    console.error(`[Purge Count] Invalid timestamps: start=${timeRangeStart} (parsed: ${startTime}), end=${timeRangeEnd} (parsed: ${endTime})`);
    return res.status(400).json({ error: 'Invalid timestamp format' });
  }
  
  params.push(startTime, endTime);

  const whereClause = whereConditions.join(' AND ');

  // Execute the count query
  const countQuery = `SELECT COUNT(*) as count FROM transcriptions WHERE ${whereClause}`;
  
  // Check if database is available
  if (!db) {
    console.error('[Purge Count] Database not available');
    return res.status(500).json({ error: 'Database not available' });
  }
  
  db.get(countQuery, params, (err, row) => {
    if (err) {
      console.error('Error counting calls:', err);
      return res.status(500).json({ error: 'Failed to count calls' });
    }

    if (!row) {
      console.error('[Purge Count] No result from count query');
      return res.status(500).json({ error: 'Failed to count calls - no result' });
    }

    res.json({ 
      success: true, 
      count: row.count
    });
  });
});

// Purge calls by setting coordinates to NULL (Admin Only when auth is enabled)
app.post('/api/calls/purge', async (req, res) => {
  try {
    // Check authentication if enabled
    if (ENABLE_AUTH?.toLowerCase() === 'true') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !(await isAdminUser(authHeader))) {
        return res.status(403).json({ error: 'Admin access required' });
      }
    }

    const { talkgroupIds, categories, timeRangeStart, timeRangeEnd } = req.body;

    // Validate input
    if (!timeRangeStart || !timeRangeEnd) {
      return res.status(400).json({ error: 'Time range is required' });
    }

    // Build the WHERE clause dynamically
    let whereConditions = ['lat IS NOT NULL AND lon IS NOT NULL']; // Only purge calls that have coordinates
    let params = [];

      // Add talkgroup filter if specified
  // If no talkgroups selected, it means "all talkgroups" (no filter applied)
  if (talkgroupIds && talkgroupIds.length > 0) {
    whereConditions.push(`talk_group_id IN (${talkgroupIds.map(() => '?').join(',')})`);
    params.push(...talkgroupIds);
  }
  // If no talkgroups selected, don't add any filter - this means "all talkgroups"

    // Add category filter if specified
    if (categories && categories.length > 0) {
      // Use UPPER() to make case-insensitive comparison
      whereConditions.push(`UPPER(category) IN (${categories.map(() => 'UPPER(?)').join(',')})`);
      params.push(...categories);
    }

    // Add time range filter
    whereConditions.push('timestamp BETWEEN ? AND ?');
    const startTime = parseInt(timeRangeStart);
    const endTime = parseInt(timeRangeEnd);
    
    // Validate parsed timestamps
    if (isNaN(startTime) || isNaN(endTime)) {
      console.error(`[Purge] Invalid timestamps: start=${timeRangeStart} (parsed: ${startTime}), end=${timeRangeEnd} (parsed: ${endTime})`);
      return res.status(400).json({ error: 'Invalid timestamp format' });
    }
    
    params.push(startTime, endTime);

    const whereClause = whereConditions.join(' AND ');

    // Check if database is available
    if (!db) {
      console.error('[Purge] Database not available');
      return res.status(500).json({ error: 'Database not available' });
    }

    // Store original coordinates before purging
    try {
      const originalCoords = await storeOriginalCoordinates(talkgroupIds, categories, startTime, endTime);
      
      // Execute the purge query
      const purgeQuery = `UPDATE transcriptions SET lat = NULL, lon = NULL WHERE ${whereClause}`;
      
      db.run(purgeQuery, params, function(err) {
        if (err) {
          console.error('Error purging calls:', err);
          return res.status(500).json({ error: 'Failed to purge calls' });
        }

        // Store the last purge details for undo functionality
        lastPurgeDetails = {
          talkgroupIds: talkgroupIds || [],
          categories: categories || [],
          timeRangeStart: startTime,
          timeRangeEnd: endTime,
          purgedCount: this.changes,
          timestamp: Date.now(),
          originalCoordinates: originalCoords
        };

        res.json({ 
          success: true, 
          purgedCount: this.changes,
          message: `Successfully purged ${this.changes} calls from the map`
        });
      });
    } catch (coordError) {
      console.error('Error storing original coordinates:', coordError);
      return res.status(500).json({ error: 'Failed to store original coordinates for undo' });
    }
  } catch (error) {
    console.error('Unexpected error in purge endpoint:', error);
    res.status(500).json({ error: 'Internal server error during purge operation' });
  }
});

// Check if there's a purge operation that can be undone
app.get('/api/calls/can-undo-purge', async (req, res) => {
  // Check authentication if enabled
  if (ENABLE_AUTH?.toLowerCase() === 'true') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !(await isAdminUser(authHeader))) {
      return res.status(403).json({ error: 'Admin access required' });
    }
  }

  if (!lastPurgeDetails) {
    return res.json({ canUndo: false, message: 'No purge operation to undo' });
  }

  // No time limit for undo operations

  res.json({ 
    canUndo: true, 
    message: `Can undo purge of ${lastPurgeDetails.purgedCount} calls`,
    purgeDetails: {
      categories: lastPurgeDetails.categories,
      talkgroups: lastPurgeDetails.talkgroupIds,
      timeRange: {
        start: new Date(lastPurgeDetails.timeRangeStart * 1000).toLocaleString(),
        end: new Date(lastPurgeDetails.timeRangeEnd * 1000).toLocaleString()
      },
      timestamp: new Date(lastPurgeDetails.timestamp).toLocaleString()
    }
  });
});

// Undo last purge operation (Admin Only when auth is enabled)
app.post('/api/calls/undo-last-purge', async (req, res) => {
  try {
    // Check authentication if enabled
    if (ENABLE_AUTH?.toLowerCase() === 'true') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !(await isAdminUser(authHeader))) {
        return res.status(403).json({ error: 'Admin access required' });
      }
    }

    // Check if there's a last purge to undo
    if (!lastPurgeDetails) {
      return res.status(400).json({ error: 'No purge operation to undo' });
    }

    // No time limit for undo operations

    // Build the WHERE clause to restore coordinates
    let whereConditions = ['lat IS NULL AND lon IS NULL']; // Only restore calls that have no coordinates
    let params = [];

    // Add talkgroup filter if specified
    if (lastPurgeDetails.talkgroupIds && lastPurgeDetails.talkgroupIds.length > 0) {
      whereConditions.push(`talk_group_id IN (${lastPurgeDetails.talkgroupIds.map(() => '?').join(',')})`);
      params.push(...lastPurgeDetails.talkgroupIds);
    }

    // Add category filter if specified
    if (lastPurgeDetails.categories && lastPurgeDetails.categories.length > 0) {
      // Use UPPER() to make case-insensitive comparison
      whereConditions.push(`UPPER(category) IN (${lastPurgeDetails.categories.map(() => 'UPPER(?)').join(',')})`);
      params.push(...lastPurgeDetails.categories);
    }

    // Add time range filter
    whereConditions.push('timestamp BETWEEN ? AND ?');
    params.push(lastPurgeDetails.timeRangeStart, lastPurgeDetails.timeRangeEnd);

    const whereClause = whereConditions.join(' AND ');

    // Execute the restore query
    const restoreQuery = `UPDATE transcriptions SET lat = (SELECT lat FROM transcriptions_backup WHERE id = transcriptions.id), lon = (SELECT lon FROM transcriptions_backup WHERE id = transcriptions.id) WHERE ${whereClause}`;
    
    // Since we don't have a backup table, we'll need to restore from the original coordinates
    // For now, we'll use a different approach - restore based on the original query
    const restoreQuery2 = `UPDATE transcriptions SET lat = (SELECT lat FROM transcriptions WHERE id = transcriptions.id), lon = (SELECT lon FROM transcriptions WHERE id = transcriptions.id) WHERE ${whereClause}`;
    
    // Check if database is available
    if (!db) {
      console.error('[Undo Purge] Database not available');
      return res.status(500).json({ error: 'Database not available' });
    }

    // Check if we have the original coordinates stored
    if (!lastPurgeDetails.originalCoordinates || lastPurgeDetails.originalCoordinates.length === 0) {
      return res.status(400).json({ error: 'No original coordinates available for restoration' });
    }

    // Restore the original coordinates for each call
    let restoredCount = 0;
    let hasError = false;

    for (const coord of lastPurgeDetails.originalCoordinates) {
      const restoreQuery = `UPDATE transcriptions SET lat = ?, lon = ? WHERE id = ?`;
      
      db.run(restoreQuery, [coord.lat, coord.lon, coord.id], function(err) {
        if (err) {
          console.error(`Error restoring coordinates for call ${coord.id}:`, err);
          hasError = true;
        } else {
          restoredCount++;
        }
      });
    }

    // Wait a bit for all updates to complete, then respond
    setTimeout(() => {
      if (hasError) {
        return res.status(500).json({ error: 'Some calls could not be restored' });
      }

      // Clear the last purge details after successful undo
      const undonePurgeDetails = { ...lastPurgeDetails };
      lastPurgeDetails = null;

      res.json({ 
        success: true, 
        restoredCount: restoredCount,
        message: `Successfully restored ${restoredCount} calls to the map`,
        undonePurge: undonePurgeDetails
      });
    }, 100);

  } catch (error) {
    console.error('Unexpected error in undo purge endpoint:', error);
    res.status(500).json({ error: 'Internal server error during undo operation' });
  }
});

// General error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('Shutting down web server gracefully...');
  server.close(() => {
    console.log('Express server closed.');
    db.close((err) => {
      if (err) {
        console.error('Error closing database connection:', err);
      } else {
        console.log('Database connection closed.');
      }
      process.exit(0);
    });
  });
});
