require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const chrono = require('chrono-node');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
const port = process.env.PORT || 8000;

const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID_ALTERNATE, process.env.TWILIO_AUTH_TOKEN_ALTERNATE);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

const sessions = {};

app.post('/whatsapp', async (req, res) => {

  console.log('inside this newfile...');
  
  const userMsg = req.body.Body;
  const userNumber = req.body.From;

  // Initialize session if not exists
  if (!sessions[userNumber]) {
    sessions[userNumber] = [
      { role: 'system', content: 'You are a smart assistant helping schedule Google Calendar meetings with Google Meet links. Extract meeting details from the conversation. If something is missing, ask the user politely and naturally.' }
    ];
  }

  // Push user message to session
  sessions[userNumber].push({ role: 'user', content: userMsg });

  // Generate reply with full context
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
              items: { type: 'string', format: 'email' },
            },
          },
          required: ['title', 'date', 'startTime', 'durationMinutes'],
        },
      },
    ],
    function_call: 'auto',
  });

  const gptReply = completion.choices[0].message;

  // Save assistant message for context continuity
  sessions[userNumber].push(gptReply);

  // If function call is not triggered yet, GPT is asking for more info
  if (!gptReply.function_call) {
    const twiml = new MessagingResponse();
    twiml.message(gptReply.content || "Could you provide more details?");
    return res.type('text/xml').send(twiml.toString());
  }

  // Now extract details and proceed as usual
  const args = JSON.parse(gptReply.function_call.arguments);
  const { title, date, startTime, durationMinutes, attendees = [] } = args;

  // Clear session after function call is successful
  delete sessions[userNumber];

//   const chrono = require('chrono-node');

// Combine natural date and time into one string
const naturalInput = `${date} ${startTime}`;

// Parse with chrono-node (assume Asia/Kolkata)
const parsedDateTime = chrono.parseDate(naturalInput, new Date(), { timezone: 'Asia/Kolkata' });

if (!parsedDateTime) {
  const twiml = new MessagingResponse();
  twiml.message("⚠️ Couldn't understand the date and time. Please try again with a specific time and date like 'April 12 at 14:00'.");
  return res.type('text/xml').send(twiml.toString());
}

const startDateTime = parsedDateTime;
const endDateTime = new Date(startDateTime.getTime() + durationMinutes * 60000);


console.log("Parsed values from OpenAI:");
console.log("Title:", title);
console.log("Date:", date);
console.log("startDateTime:", startDateTime);
console.log("Start Time:", startTime);
console.log("Duration (mins):", durationMinutes);
console.log("Attendees:", attendees);


  const event = {
    summary: title,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'Asia/Kolkata'
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'Asia/Kolkata'
    },
    attendees: attendees.map(email => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: Math.random().toString(36).substring(2),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  let calendarResponse;
  try {
    calendarResponse = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1
    });
  } catch (error) {
    console.error('Calendar error:', error);
    const twiml = new MessagingResponse();
    twiml.message("Failed to create calendar invite. Try again.");
    return res.type('text/xml').send(twiml.toString());
  }

  const twiml = new MessagingResponse();
  twiml.message(`Meeting created! 📅\nTitle: ${title}\nDate: *${startDateTime}*\nTime: *${startTime}*\nLink: ${calendarResponse.data.hangoutLink}`);
  res.type('text/xml').send(twiml.toString());

});

app.listen(port, () => console.log(`Server running on port ${port}`));