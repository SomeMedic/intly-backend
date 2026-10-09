import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');

function connector() {
  return new PublicApiFeedConnector('hackernews_whoishiring');
}

function hnRecord(item, threadId = 49922569) {
  return connector().hnCommentRecord(item, threadId);
}

test('hackernews decodes retained real HN entities in title and description while keeping raw payload unchanged', () => {
  const item = {
    by: 'veryfastfourier',
    id: 49937058,
    parent: 49922569,
    text: 'Vola Dynamics | Software Engineers (C++, Python) | NYC &#x2F; CT | HYBRID | Full-time<p>Vola Dynamics (<a href="https:&#x2F;&#x2F;voladynamics.com" rel="nofollow">https:&#x2F;&#x2F;voladynamics.com</a>) builds the core C++&#x2F;Java&#x2F;C#&#x2F;Python quant library that powers options trading and analytics at many of the world’s most sophisticated prop shops, market makers, hedge funds, and banks. Our volatility fitter and ultra-fast option pricers are the market standard.<p>We&#x27;re hiring for C++ engineers to work on our core library as well as Python engineers to build a new streaming data infrastructure from the ground up.<p>Work style: Hybrid in NYC or South Norwalk, CT. In-office on Tuesday and Thursday.<p>Apply here (<a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;voladynamics" rel="nofollow">https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;voladynamics</a>) or email us at &quot;resumes [at] voladynamics [dot] com&quot; and mention HN in the subject.',
    time: 1790966653,
    type: 'comment',
  };

  const record = hnRecord(item);

  assert.equal(record.title, 'Vola Dynamics | Software Engineers (C++, Python) | NYC / CT | HYBRID | Full-time');
  assert.ok(record.description.includes('https://voladynamics.com'));
  assert.ok(record.description.includes('core C++/Java/C#/Python quant library'));
  assert.ok(record.description.includes('"resumes [at] voladynamics [dot] com"'));
  assert.doesNotMatch(record.description, /&#x2F;|&#x27;|&quot;|<a\b/i);
  assert.equal(record.rawPayload, item);
  assert.match(record.rawPayload.text, /https:&#x2F;&#x2F;voladynamics\.com/);
});

test('hackernews converts HN HTML fragments to stable readable plaintext', () => {
  const item = {
    by: 'author',
    id: 1001,
    parent: 1000,
    time: 1790966653,
    type: 'comment',
    text: 'ACME &amp; Co | Senior Engineer &mdash; Platform &#x1F680;<p>Line one<br>Line two<ul><li>Remote &#x2F; Hybrid</li><li>Use &lt;bowing&gt; literally</li></ul><pre><code>Résumé&#x2F;CV: https:&#x2F;&#x2F;example.com&#x2F;cv</code></pre>',
  };

  const record = hnRecord(item, 1000);

  assert.equal(record.title, 'ACME & Co | Senior Engineer — Platform 🚀');
  assert.equal(record.description, [
    'ACME & Co | Senior Engineer — Platform 🚀',
    'Line one',
    'Line two',
    'Remote / Hybrid',
    'Use <bowing> literally',
    'Résumé/CV: https://example.com/cv',
  ].join('\n'));
});

test('hackernews strips executable and style markup but preserves encoded literal tags as text', () => {
  const item = {
    by: 'author',
    id: 1002,
    parent: 1000,
    time: 1790966653,
    type: 'comment',
    text: 'Visible <script>alert("x")</script><style>.hidden{display:none}</style><p>Encoded &lt;script&gt;safe&lt;&#x2F;script&gt; text &amp; symbols',
  };

  const record = hnRecord(item, 1000);

  assert.equal(record.title, 'Visible');
  assert.equal(record.description, 'Visible\nEncoded <script>safe</script> text & symbols');
  assert.doesNotMatch(record.description, /alert|display:none/);
});
