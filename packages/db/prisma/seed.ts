import { prisma } from '../src/index';
import bcrypt from 'bcryptjs';

async function seed() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@nexushivedesk.com';
  const password = process.env.ADMIN_PASSWORD ?? 'changeme123';
  const name = process.env.ADMIN_NAME ?? 'Admin User';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`User "${email}" already exists, skipping seed.`);
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, name, hashedPassword },
  });

  console.log(`Created admin user: ${user.email} (${user.id})`);
  console.log('Default password: changeme123 (change this in production!)');
}

seed()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
