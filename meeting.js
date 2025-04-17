require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const chrono = require('chrono-node');
const { createClient } = require('@supabase/supabase-js');
const { BitlyClient } = require('bitly');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const port = process.env.PORT || 8000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const bitly = new BitlyClient(process.env.BITLY_ACCESS_TOKEN);

const sessions = {};

const shortenUrl = async (longUrl) => {
    const response = await bitly.shorten(longUrl);
    return response.link;
  };

// Get refresh token for user
async function getRefreshToken(userNumber) {
  const { data } = await supabase
    .from('user_tokens')
    .select('refresh_token')
    .eq('phone_number', userNumber)
    .single();
  return data?.refresh_token || null;
}

// Save refresh token
async function saveRefreshToken(userNumber, refreshToken) {
  const { error } = await supabase
    .from('user_tokens')
    .upsert({ phone_number: userNumber, refresh_token: refreshToken });
  return !error;
}

// Generate OAuth2 client for specific refresh token
function getOAuthClient(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

// WhatsApp webhook
app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body?.trim();
  const userNumber = req.body.From;

  const refreshToken = await getRefreshToken(userNumber);

  if (!refreshToken) {
    const authUrl = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    ).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: `whatsapp:${userNumber}`
    });

    const twiml = new MessagingResponse();
    twiml.message(`🛡️ To schedule meetings, please sign in with Google: ${authUrl}`);
    return res.type('text/xml').send(twiml.toString());
  }

  // Initialize session
  if (!sessions[userNumber]) {
    sessions[userNumber] = [
      {
        role: 'system',
        content: `You are a helpful assistant that schedules meetings using Google Calendar.

Your job is to analyze the user's message and check if it includes all required details to schedule a meeting:
- Email of the invitee
- Date of the meeting
- Start time of the meeting
- Duration of the meeting
- Title or purpose of the meeting

If **any of these are missing**, or if **any time-related phrase is unclear** (e.g., "3pm mins", "30pm", "at 2 for 30", "tomorrow for 15 minutes" without a time), then respond with a plain text clarification message like:

"I noticed that your message is missing the meeting time. Could you please specify what time the meeting should start?"

OR

"I found a confusing phrase: '3pm mins'. Did you mean 3 PM or 30 minutes? Please reply with 1 or 2."

However, if **everything is clear and complete**, return nothing — just leave the response empty. No confirmation, no extra text.`
      }
    ];
  }

  sessions[userNumber].push({ role: 'user', content: userMsg });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: sessions[userNumber],
    functions: [
      {
        name: 'create_calendar_event',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            date: { type: 'string', format: 'date' },
            startTime: { type: 'string' },
            durationMinutes: { type: 'number' },
            attendees: {
              type: 'array',
              items: { type: 'string', format: 'email' }
            }
          },
          required: ['title', 'date', 'startTime', 'durationMinutes']
        }
      }
    ],
    function_call: 'auto'
  });

  const gptReply = completion.choices[0].message;
  sessions[userNumber].push(gptReply);

  if (!gptReply.function_call) {
    const twiml = new MessagingResponse();
    twiml.message(gptReply.content || "Could you please provide more information?");
    return res.type('text/xml').send(twiml.toString());
  }

  const args = JSON.parse(gptReply.function_call.arguments);
  const { title, date, startTime, durationMinutes, attendees = [] } = args;

  const parsedDateTime = chrono.parseDate(`${date} ${startTime}`, new Date(), { timezone: 'Asia/Kolkata' });
  if (!parsedDateTime) {
    const twiml = new MessagingResponse();
    twiml.message("⚠️ I couldn't understand the time. Please try again like 'April 16 at 2:30 PM'.");
    return res.type('text/xml').send(twiml.toString());
  }

  const endDateTime = new Date(parsedDateTime.getTime() + durationMinutes * 60000);

  const oAuth2Client = getOAuthClient(refreshToken);
  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  const event = {
    summary: title,
    start: { dateTime: parsedDateTime.toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: endDateTime.toISOString(), timeZone: 'Asia/Kolkata' },
    attendees: attendees.map(email => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: Math.random().toString(36).substring(2),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });

    const twiml = new MessagingResponse();
    twiml.message(`✅ Meeting Created!\n📌 *${title}*\n📅 ${date} at ${startTime}\n🔗 ${response.data.hangoutLink}`);
    delete sessions[userNumber];
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error creating event:', err.message);
    const twiml = new MessagingResponse();
    twiml.message("❌ Failed to create calendar event. Please try again.");
    return res.type('text/xml').send(twiml.toString());
  }
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state || !state.startsWith('whatsapp:')) {
    return res.send('Invalid request');
  }

  const userNumber = state.replace('whatsapp:', '');
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return res.send("❌ Google didn't return a refresh token. Try again.");
    }

    console.log('tokens',tokens);
    
    const saved = await saveRefreshToken(userNumber, tokens.refresh_token);
    if (!saved) return res.send('❌ Failed to save token.');

    return res.send('✅ Authentication successful! You can now schedule meetings on WhatsApp.');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.send('❌ Failed to authenticate with Google.');
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
