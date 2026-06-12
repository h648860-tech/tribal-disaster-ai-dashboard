const fetch = require('node-fetch');

const cwaApiKey = "CWA-C3660269-71CE-4070-824F-0A4620654C06";
const rainUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${cwaApiKey}&format=JSON`;

async function main() {
  try {
    const res = await fetch(rainUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (data && data.records && data.records.Station) {
      // Search for StationName containing "山豬窟" or "達仁" or "森永" or "安朔" or "土坂" or "台坂" or "新化"
      const keywords = ["山豬窟", "達仁", "森永", "安朔", "土坂", "台坂", "新化"];
      const matched = data.records.Station.filter(st => 
        keywords.some(kw => st.StationName.includes(kw) || (st.GeoInfo && st.GeoInfo.TownName && st.GeoInfo.TownName.includes(kw)))
      );
      
      console.log("MATCHED_STATIONS:", JSON.stringify(matched, null, 2));
    } else {
      console.log("CWA_DATA: records.Station not found.");
    }
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

main();
