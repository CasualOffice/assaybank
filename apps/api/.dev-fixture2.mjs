import postgres from 'postgres';
const sql = postgres('postgres://hiring:hiring@localhost:5432/hiring', { max: 1 });
const ORG = '11111111-0000-4000-8000-000000000001';
const PROMPTS = [
  'Implement an LRU cache with O(1) get and put.',
  'Given a binary tree, return its level-order traversal.',
  'Write a SQL query returning the second-highest salary per department.',
  'Design a rate limiter for an API gateway handling 50k requests per second.',
  'Reverse a singly linked list in place, without extra allocation.',
  'Find the longest substring without repeating characters.',
  'Explain how you would migrate a 4TB table with no downtime.',
  'Merge k sorted lists into one sorted list.',
  'Detect a cycle in a directed graph and return one if present.',
  'Given a stream of integers, maintain the running median.',
  'Write a query to find customers with no orders in the last 90 days.',
  'Implement exponential backoff with jitter for a flaky downstream call.',
];
const KINDS = ['coding', 'sql', 'system_design', 'short_answer', 'mcq_single'];
try {
  const skills =
    await sql`SELECT id, key, name FROM skills WHERE org_id IS NULL ORDER BY key LIMIT 8`;
  let n = 0;
  for (const s of skills) {
    // Vary how well covered each skill is: some deep, some thin, some empty.
    const depth = [14, 9, 6, 3, 1, 0, 11, 4][skills.indexOf(s)] ?? 3;
    for (let i = 0; i < depth; i += 1) {
      const kind = KINDS[(i + skills.indexOf(s)) % KINDS.length];
      const difficulty = 1 + ((i * 2 + skills.indexOf(s)) % 5);
      const status = i % 9 === 0 && i > 0 ? 'review' : 'published';
      const [q] = await sql`INSERT INTO questions (id, org_id, kind, status)
        VALUES (gen_random_uuid(), ${ORG}, ${kind}, ${status}) RETURNING id`;
      const [v] =
        await sql`INSERT INTO question_versions (id, question_id, version_no, prompt_md, difficulty, est_seconds)
        VALUES (gen_random_uuid(), ${q.id}, 1, ${PROMPTS[n % PROMPTS.length]}, ${difficulty}, ${180 + (i % 4) * 120}) RETURNING id`;
      if (status === 'published') {
        await sql`UPDATE questions SET current_version_id = ${v.id} WHERE id = ${q.id}`;
        await sql`UPDATE question_versions SET published_at = now() WHERE id = ${v.id}`;
      }
      await sql`INSERT INTO question_skills (question_id, skill_id) VALUES (${q.id}, ${s.id}) ON CONFLICT DO NOTHING`;
      n += 1;
    }
  }
  // A third role that should read as ready, over the two deepest skills.
  const deep = [skills[0], skills[6]].filter(Boolean);
  const [role] =
    await sql`INSERT INTO job_roles (id, org_id, code, title, family, seniority, is_active)
    VALUES (gen_random_uuid(), ${ORG}, 'platform-mid', 'Platform engineer', 'Engineering', 'Mid', true)
    ON CONFLICT (org_id, code) DO UPDATE SET title = EXCLUDED.title RETURNING id`;
  for (const s of deep) {
    await sql`INSERT INTO job_role_skills (job_role_id, skill_id, weight, min_difficulty, max_difficulty, is_required)
      VALUES (${role.id}, ${s.id}, 1, 1, 5, true) ON CONFLICT DO NOTHING`;
  }
  console.log('added', n, 'questions across', skills.length, 'skills');
} finally {
  await sql.end();
}
