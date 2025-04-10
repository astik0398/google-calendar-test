const express = require("express");
const { google } = require("googleapis");
const dotenv = require("dotenv");
dotenv.config();
const cors = require('cors')
const app = express();
app.use(express.json());
app.use(cors())

const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// Redirect to Google OAuth
app.get("/auth", (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    });
    res.redirect(url);
});

// Handle OAuth callback
app.get("/oauth2callback", async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.send("Authentication successful! You can close this window.");
});

// Schedule a meeting
app.post("/schedule-meet", async (req, res) => {

    console.log('inside be schedule-meet...');
    
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: "Email is required" });
        }

        const calendar = google.calendar({ version: "v3", auth: oauth2Client });

        const event = {
            summary: "Scheduled Meeting",
            description: "This is an auto-scheduled Google Meet.",
            start: {
                dateTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
                timeZone: "Asia/Tokyo",
            },
            end: {
                dateTime: new Date(Date.now() + 7200000).toISOString(), // 2 hours from now
                timeZone: "Asia/Tokyo",
            },
            attendees: [{ email }],
            conferenceData: {
                createRequest: { requestId: "sample123" },
            },
        };

        const response = await calendar.events.insert({
            calendarId: "primary",
            resource: event,
            conferenceDataVersion: 1,
        });

        res.json({ meetLink: response.data.hangoutLink });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(8000, () => {
    console.log("Server running on http://localhost:8000");
});