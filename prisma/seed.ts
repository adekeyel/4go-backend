import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("No seed data defined yet. Add fixtures here as needed (e.g. a first super admin).");
  // Example: promote a user to super admin after they've signed up once:
  // await prisma.superAdmins.create({ data: { user_id: "<uuid-from-users-table>", role: "super_admin" } });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
