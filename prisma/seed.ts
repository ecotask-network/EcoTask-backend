import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SAMPLE_TASKS = [
  { title: "Clean up Riverside Park", description: "Collect litter along the river trail from the bridge to the playground. Bags and gloves provided at the park office.", type: "cleanup", rewardAmount: 50, lat: 40.7128, lng: -74.006, status: "ACTIVE", expiresAt: new Date("2026-07-01") },
  { title: "Plant Native Trees in Greenfield", description: "Help plant 20 native oak saplings in the community woodland. Tools and saplings on site.", type: "planting", rewardAmount: 75, lat: 40.7282, lng: -73.7949, status: "ACTIVE", expiresAt: new Date("2026-06-20") },
  { title: "Recycling Drive - Downtown Hub", description: "Sort and process recyclables at the downtown collection center. Morning shift 8 AM - 12 PM.", type: "recycling", rewardAmount: 30, lat: 40.758, lng: -73.9855, status: "ACTIVE", expiresAt: new Date("2026-06-15") },
  { title: "Beach Cleanup at Brighton Shore", description: "Remove plastic waste and debris from the shoreline. Meet at lifeguard station #3.", type: "cleanup", rewardAmount: 60, lat: 40.5771, lng: -73.9351, status: "ACTIVE", expiresAt: new Date("2026-06-25") },
  { title: "Community Garden Expansion", description: "Expand the raised garden beds at the Eastside community garden. Bring gardening gloves.", type: "planting", rewardAmount: 45, lat: 40.7484, lng: -73.9857, status: "ACTIVE", expiresAt: new Date("2026-06-30") },
  { title: "E-Waste Collection Event", description: "Help residents drop off old electronics for proper recycling at the city hall parking lot.", type: "recycling", rewardAmount: 40, lat: 40.7127, lng: -74.0059, status: "ACTIVE", expiresAt: new Date("2026-06-18") },
  { title: "Trail Maintenance - Pine Ridge", description: "Clear fallen branches and repair erosion damage on the Pine Ridge hiking trail.", type: "cleanup", rewardAmount: 55, lat: 41.2033, lng: -73.7263, status: "ACTIVE", expiresAt: new Date("2026-07-10") },
  { title: "Urban Tree Watering", description: "Water newly planted street trees along Main Street. Water truck provided.", type: "planting", rewardAmount: 25, lat: 40.7061, lng: -74.0087, status: "ACTIVE", expiresAt: new Date("2026-06-12") },
  { title: "Glass Recycling Sort", description: "Sort recycled glass by color at the material recovery facility.", type: "recycling", rewardAmount: 35, lat: 40.7243, lng: -74.0018, status: "ACTIVE", expiresAt: new Date("2026-06-22") },
  { title: "Riverbank Restoration", description: "Plant native riparian vegetation along the Hudson riverbank near Pier 40.", type: "planting", rewardAmount: 80, lat: 40.7282, lng: -74.0102, status: "ACTIVE", expiresAt: new Date("2026-07-05") },
  { title: "Neighborhood Litter Pickup", description: "Walk and collect litter from the streets between 5th and 8th Avenues. Supplies at the community center.", type: "cleanup", rewardAmount: 20, lat: 40.7456, lng: -73.9888, status: "ACTIVE", expiresAt: new Date("2026-06-14") },
  { title: "Compost Workshop Setup", description: "Set up bins and signage for the weekend compost workshop at the sustainability center.", type: "recycling", rewardAmount: 30, lat: 40.7384, lng: -73.9973, status: "ACTIVE", expiresAt: new Date("2026-06-28") },
  { title: "Park Bench Installation", description: "Assemble and install 5 recycled-plastic park benches in Washington Square Park.", type: "cleanup", rewardAmount: 65, lat: 40.7308, lng: -73.9973, status: "ACTIVE", expiresAt: new Date("2026-07-08") },
  { title: "School Garden Workshop", description: "Teach kids at PS 123 how to plant and care for vegetable starts in the school garden.", type: "planting", rewardAmount: 50, lat: 40.7573, lng: -73.9857, status: "ACTIVE", expiresAt: new Date("2026-06-19") },
  { title: "Battery Recycling Drive", description: "Collect and sort household batteries at the library drop-off station.", type: "recycling", rewardAmount: 25, lat: 40.7527, lng: -73.9772, status: "ACTIVE", expiresAt: new Date("2026-06-16") },
  { title: "Marshland Cleanup", description: "Remove invasive water hyacinth from the Jamaica Bay marsh. Waders provided.", type: "cleanup", rewardAmount: 70, lat: 40.6142, lng: -73.8441, status: "ACTIVE", expiresAt: new Date("2026-07-12") },
  { title: "Rooftop Garden Planting", description: "Plant drought-resistant sedums on the green roof of the municipal building.", type: "planting", rewardAmount: 60, lat: 40.7431, lng: -73.989, status: "ACTIVE", expiresAt: new Date("2026-06-21") },
  { title: "Plastic Bottle Collection", description: "Collect plastic bottles from the sports complex after the weekend tournament.", type: "recycling", rewardAmount: 20, lat: 40.7888, lng: -73.9746, status: "ACTIVE", expiresAt: new Date("2026-06-26") },
  { title: "Expired Cleanup Task", description: "This task has expired and should not appear in active listings.", type: "cleanup", rewardAmount: 10, lat: 40.7128, lng: -74.006, status: "EXPIRED", expiresAt: new Date("2025-01-01") },
  { title: "Completed Tree Planting", description: "This task was already completed.", type: "planting", rewardAmount: 40, lat: 40.7282, lng: -73.7949, status: "COMPLETED", expiresAt: new Date("2025-06-01") },
];

async function main() {
  console.log("Seeding tasks...");

  for (const task of SAMPLE_TASKS) {
    await prisma.task.create({ data: task });
  }

  console.log(`Seeded ${SAMPLE_TASKS.length} tasks`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
