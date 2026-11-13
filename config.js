// Settings you can change without touching the rest of the app.

// Your Cesium ion access token (from https://ion.cesium.com/tokens).
// Leave it empty to use Cesium's shared demo token, which works for testing
// but shows a warning banner at the bottom of the globe.
window.CESIUM_ION_TOKEN = "";

// Where the globe starts: west, south, east, north in degrees.
// This frames the US west coast from Baja California to Washington.
window.START_VIEW = [-128, 30, -113, 50];

// The private GitHub repository where "My lines" are saved so every device
// sees them, as owner/name. Each device also needs a token for it, pasted in
// the panel under "Keep lines on all my devices".
window.LINES_REPO = "adso-of-melk/consonance-lines";
