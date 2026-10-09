import { writeFile } from 'node:fs/promises';
async function exportContract() {
  const response = await fetch(`${process.env.API_URL ?? 'http://localhost:3001'}/api/v1/openapi.json`);
  if (!response.ok) throw new Error(`OpenAPI export failed: ${response.status}`);
  const schema = await response.json();
  await writeFile('openapi.json', JSON.stringify(schema, null, 2));
  console.log('Exported current backend OpenAPI contract to openapi.json');
}
void exportContract().catch(error => { console.error(error.message); process.exitCode = 1; });
