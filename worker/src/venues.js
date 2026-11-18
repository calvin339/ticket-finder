// Venues the search worker reads. `kind` picks the parser in index.js.
// To add a venue that uses one of these site types, add a line here.
export const VENUES = [
  // Live Nation sites: exact presale + on-sale times, presale codes
  { name: "The Fillmore", city: "San Francisco, CA", lat: 37.7840, lon: -122.4330, kind: "livenation", url: "https://www.thefillmore.com/shows" },
  { name: "SF Masonic", city: "San Francisco, CA", lat: 37.7913, lon: -122.4128, kind: "livenation", url: "https://www.sfmasonic.com/shows" },
  // TicketWeb plugin: on-sale dates
  { name: "The Independent", city: "San Francisco, CA", lat: 37.7755, lon: -122.4378, kind: "ticketweb", url: "https://www.theindependentsf.com/" },
  { name: "August Hall", city: "San Francisco, CA", lat: 37.7874, lon: -122.4109, kind: "ticketweb", url: "https://www.augusthallsf.com/" },
  { name: "Brick & Mortar Music Hall", city: "San Francisco, CA", lat: 37.7697, lon: -122.4200, kind: "ticketweb", url: "https://www.brickandmortarmusic.com/" },
  { name: "Bimbo's 365 Club", city: "San Francisco, CA", lat: 37.8034, lon: -122.4155, kind: "ticketweb", url: "https://www.bimbos365club.com/" },
  { name: "Neck of the Woods", city: "San Francisco, CA", lat: 37.7829, lon: -122.4642, kind: "ticketweb", url: "https://www.neckofthewoodssf.com/" },
  // Another Planet sites: presale dates (times when listed)
  // The Fox's home page has exact presale times ("…at 10am"); the listing page has every show.
  { name: "Fox Theater", city: "Oakland, CA", lat: 37.8080, lon: -122.2700, kind: "anotherplanet", url: "https://thefoxoakland.com/listing/", extraUrls: ["https://thefoxoakland.com/"] },
  { name: "Greek Theatre", city: "Berkeley, CA", lat: 37.8738, lon: -122.2546, kind: "anotherplanet", url: "https://thegreekberkeley.com/" },
  { name: "Bill Graham Civic Auditorium", city: "San Francisco, CA", lat: 37.7785, lon: -122.4170, kind: "anotherplanet", url: "https://www.billgrahamcivic.com/" },
  // The UC Theatre (Berkeley): shows and ticket links
  { name: "The UC Theatre", city: "Berkeley, CA", lat: 37.8716, lon: -122.2685, kind: "uctheatre", url: "https://www.theuctheatre.org/events" },
  // SeeTickets plugin: exact on-sale times from each show's page
  { name: "The Chapel", city: "San Francisco, CA", lat: 37.7604, lon: -122.4213, kind: "seetickets", url: "https://thechapelsf.com/calendar/", extraUrls: ["https://www.thechapelsf.com/music/"] },
  { name: "Great American Music Hall", city: "San Francisco, CA", lat: 37.7849, lon: -122.4189, kind: "seetickets", url: "https://gamh.com/" },
  { name: "Hotel Utah", city: "San Francisco, CA", lat: 37.7792, lon: -122.3990, kind: "seetickets", url: "https://www.hotelutah.com/" },
  // Café du Nord + Swedish American Hall (one site): exact presale + on-sale times from each show's page
  { name: "Cafe du Nord", city: "San Francisco, CA", lat: 37.7666, lon: -122.4291, kind: "billja", url: "https://www.cafedunord.com/" },
  // Bottom of the Hill: shows and ticket links
  { name: "Bottom of the Hill", city: "San Francisco, CA", lat: 37.7649, lon: -122.3964, kind: "bottomofthehill", url: "https://www.bottomofthehill.com/calendar.html" },
];
