// Venues the search worker reads. `kind` picks the parser in index.js.
// To add a venue that uses one of these site types, add a line here.
export const VENUES = [
  { name: "The Fillmore", city: "San Francisco, CA", lat: 37.7840, lon: -122.4330, kind: "livenation", url: "https://www.thefillmore.com/shows" },
  { name: "SF Masonic", city: "San Francisco, CA", lat: 37.7913, lon: -122.4128, kind: "livenation", url: "https://www.sfmasonic.com/shows" },
  { name: "The Independent", city: "San Francisco, CA", lat: 37.7755, lon: -122.4378, kind: "ticketweb", url: "https://www.theindependentsf.com/" },
  { name: "August Hall", city: "San Francisco, CA", lat: 37.7874, lon: -122.4109, kind: "ticketweb", url: "https://www.augusthallsf.com/" },
  { name: "Brick & Mortar Music Hall", city: "San Francisco, CA", lat: 37.7697, lon: -122.4200, kind: "ticketweb", url: "https://www.brickandmortarmusic.com/" },
  { name: "Fox Theater", city: "Oakland, CA", lat: 37.8080, lon: -122.2700, kind: "anotherplanet", url: "https://thefoxoakland.com/listing/" },
  { name: "Greek Theatre", city: "Berkeley, CA", lat: 37.8738, lon: -122.2546, kind: "anotherplanet", url: "https://thegreekberkeley.com/" },
];
