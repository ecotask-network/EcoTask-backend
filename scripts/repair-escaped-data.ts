/**
 * Migration script to repair HTML-escaped data in the database.
 * 
 * This script fixes data corruption caused by the sanitizeInput middleware
 * that HTML-escaped strings on input. Since the API returns JSON (not HTML),
 * this escaping provided no XSS defense and only corrupted data.
 * 
 * Affected fields:
 * - User: name, bio
 * - Task: title, description
 * - Proof: notes
 * - Verification: notes
 * - ValidatorVote: notes
 * - Notification: title, body
 * 
 * URL fields (avatarUrl, webhookUrl) should NOT be unescaped as they may
 * legitimately contain & characters.
 */

import prisma from '../src/utils/prisma.js';

function unescapeHtml(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x3D;/g, '=');
}

async function repairUsers() {
  console.log('Repairing User records...');
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: '&amp;' } },
        { name: { contains: '&lt;' } },
        { name: { contains: '&gt;' } },
        { name: { contains: '&quot;' } },
        { name: { contains: '&#x27;' } },
        { name: { contains: '&#39;' } },
        { bio: { contains: '&amp;' } },
        { bio: { contains: '&lt;' } },
        { bio: { contains: '&gt;' } },
        { bio: { contains: '&quot;' } },
        { bio: { contains: '&#x27;' } },
        { bio: { contains: '&#39;' } },
      ],
    },
  });

  let repaired = 0;
  for (const user of users) {
    const nameUnescaped = unescapeHtml(user.name);
    const bioUnescaped = unescapeHtml(user.bio);
    
    if (nameUnescaped !== user.name || bioUnescaped !== user.bio) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          name: nameUnescaped,
          bio: bioUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired user ${user.id}: name="${user.name}" -> "${nameUnescaped}"`);
    }
  }
  console.log(`  Repaired ${repaired} User records`);
}

async function repairTasks() {
  console.log('Repairing Task records...');
  const tasks = await prisma.task.findMany({
    where: {
      OR: [
        { title: { contains: '&amp;' } },
        { title: { contains: '&lt;' } },
        { title: { contains: '&gt;' } },
        { title: { contains: '&quot;' } },
        { title: { contains: '&#x27;' } },
        { title: { contains: '&#39;' } },
        { description: { contains: '&amp;' } },
        { description: { contains: '&lt;' } },
        { description: { contains: '&gt;' } },
        { description: { contains: '&quot;' } },
        { description: { contains: '&#x27;' } },
        { description: { contains: '&#39;' } },
      ],
    },
  });

  let repaired = 0;
  for (const task of tasks) {
    const titleUnescaped = unescapeHtml(task.title);
    const descriptionUnescaped = unescapeHtml(task.description);
    
    if (titleUnescaped !== task.title || descriptionUnescaped !== task.description) {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          title: titleUnescaped,
          description: descriptionUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired task ${task.id}: title="${task.title}" -> "${titleUnescaped}"`);
    }
  }
  console.log(`  Repaired ${repaired} Task records`);
}

async function repairProofs() {
  console.log('Repairing Proof records...');
  const proofs = await prisma.proof.findMany({
    where: {
      notes: {
        contains: '&amp;',
      },
    },
  });

  let repaired = 0;
  for (const proof of proofs) {
    const notesUnescaped = unescapeHtml(proof.notes);
    
    if (notesUnescaped !== proof.notes) {
      await prisma.proof.update({
        where: { id: proof.id },
        data: {
          notes: notesUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired proof ${proof.id}`);
    }
  }
  console.log(`  Repaired ${repaired} Proof records`);
}

async function repairVerifications() {
  console.log('Repairing Verification records...');
  const verifications = await prisma.verification.findMany({
    where: {
      notes: {
        contains: '&amp;',
      },
    },
  });

  let repaired = 0;
  for (const verification of verifications) {
    const notesUnescaped = unescapeHtml(verification.notes);
    
    if (notesUnescaped !== verification.notes) {
      await prisma.verification.update({
        where: { id: verification.id },
        data: {
          notes: notesUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired verification ${verification.id}`);
    }
  }
  console.log(`  Repaired ${repaired} Verification records`);
}

async function repairValidatorVotes() {
  console.log('Repairing ValidatorVote records...');
  const votes = await prisma.validatorVote.findMany({
    where: {
      notes: {
        contains: '&amp;',
      },
    },
  });

  let repaired = 0;
  for (const vote of votes) {
    const notesUnescaped = unescapeHtml(vote.notes);
    
    if (notesUnescaped !== vote.notes) {
      await prisma.validatorVote.update({
        where: { id: vote.id },
        data: {
          notes: notesUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired validator vote ${vote.id}`);
    }
  }
  console.log(`  Repaired ${repaired} ValidatorVote records`);
}

async function repairNotifications() {
  console.log('Repairing Notification records...');
  const notifications = await prisma.notification.findMany({
    where: {
      OR: [
        { title: { contains: '&amp;' } },
        { title: { contains: '&lt;' } },
        { title: { contains: '&gt;' } },
        { title: { contains: '&quot;' } },
        { title: { contains: '&#x27;' } },
        { title: { contains: '&#39;' } },
        { body: { contains: '&amp;' } },
        { body: { contains: '&lt;' } },
        { body: { contains: '&gt;' } },
        { body: { contains: '&quot;' } },
        { body: { contains: '&#x27;' } },
        { body: { contains: '&#39;' } },
      ],
    },
  });

  let repaired = 0;
  for (const notification of notifications) {
    const titleUnescaped = unescapeHtml(notification.title);
    const bodyUnescaped = unescapeHtml(notification.body);
    
    if (titleUnescaped !== notification.title || bodyUnescaped !== notification.body) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          title: titleUnescaped,
          body: bodyUnescaped,
        },
      });
      repaired++;
      console.log(`  Repaired notification ${notification.id}`);
    }
  }
  console.log(`  Repaired ${repaired} Notification records`);
}

async function main() {
  console.log('Starting data repair migration...');
  console.log('This will unescape HTML entities in text fields.');
  console.log('URL fields (avatarUrl, webhookUrl) are NOT modified.\n');

  try {
    await repairUsers();
    await repairTasks();
    await repairProofs();
    await repairVerifications();
    await repairValidatorVotes();
    await repairNotifications();
    
    console.log('\n✅ Data repair completed successfully.');
  } catch (error) {
    console.error('\n❌ Error during data repair:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main();
