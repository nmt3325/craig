import { readFileSync } from 'node:fs';

const TOKEN = 'process.env.NOTION_TOKEN';
const DATABASE_ID = '24b682e899498011bb89df003cf8773a';
const NOTION_VERSION = '2022-06-28';

function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    ...extra,
  };
}

async function main() {
  // --- Step 1: Create a file upload session ---
  console.log('Step 1: Creating file upload session...');
  const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'single_part' }),
  });
  const createData = await createRes.json();
  console.log('Create response:', JSON.stringify(createData, null, 2));

  if (!createRes.ok) {
    console.error('Failed at step 1');
    process.exit(1);
  }

  // --- Step 2: Upload the file ---
  const fileUploadId = createData.id;
  console.log(`\nStep 2: Uploading file to upload ID ${fileUploadId}...`);

  const fileContent = readFileSync('/tmp/test-audio.aac');
  const formData = new FormData();
  formData.append('part_number', '1');
  formData.append('file', new Blob([fileContent], { type: 'audio/aac' }), 'test.aac');

  const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${fileUploadId}/send`, {
    method: 'POST',
    headers: headers(),
    body: formData,
  });
  const sendData = await sendRes.json();
  console.log('Send response:', JSON.stringify(sendData, null, 2));

  if (!sendRes.ok) {
    console.error('Failed at step 2');
    process.exit(1);
  }

  // --- Step 3: Get the database to find the title property ---
  console.log('\nStep 3: Fetching database to find title property...');
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
    headers: headers(),
  });
  const dbData = await dbRes.json();
  console.log('Database title:', dbData.title?.[0]?.plain_text);

  if (!dbRes.ok) {
    console.error('Failed at step 3:', JSON.stringify(dbData, null, 2));
    process.exit(1);
  }

  const titlePropName = Object.entries(dbData.properties).find(([, v]) => v.type === 'title')?.[0] ?? 'Name';
  console.log('Title property name:', titlePropName);

  // --- Step 4: Create a page with the file block ---
  console.log('\nStep 4: Creating Notion page...');
  const pageRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      parent: { database_id: DATABASE_ID },
      properties: {
        [titlePropName]: {
          title: [{ text: { content: 'Test Upload - Craig' } }],
        },
      },
      children: [
        {
          object: 'block',
          type: 'audio',
          audio: {
            type: 'file_upload',
            file_upload: { id: fileUploadId },
          },
        },
      ],
    }),
  });
  const pageData = await pageRes.json();
  console.log('Page create response:', JSON.stringify(pageData, null, 2));

  if (pageRes.ok) {
    console.log(`\nSuccess! Page URL: https://notion.so/${pageData.id.replace(/-/g, '')}`);
  } else {
    console.error('Failed at step 4');
  }
}

main().catch(console.error);
