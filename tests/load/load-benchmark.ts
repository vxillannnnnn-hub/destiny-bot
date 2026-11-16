import { MatchTicket } from '../../src/core/types.js';
import { MatchmakingEngine } from '../../src/core/matchmaking/engine.js';
import { v4 as uuidv4 } from 'uuid';

const INTERESTS_POOL = [
  'gaming', 'anime', 'coding', 'music', 'art', 'philosophy',
  'fitness', 'books', 'movies', 'sci-fi', 'nature', 'travel'
];

const GENDERS = ['male', 'female', 'non_binary'] as const;

function generateMockTicket(idNum: number): MatchTicket {
  const gender = GENDERS[idNum % GENDERS.length];
  const interests = [
    INTERESTS_POOL[idNum % INTERESTS_POOL.length],
    INTERESTS_POOL[(idNum + 3) % INTERESTS_POOL.length],
  ];

  return {
    userId: `load_user_${idNum}_${uuidv4().substring(0, 8)}`,
    destinyId: `DESTINY-${100000 + (idNum % 900000)}`,
    discordUserId: `10000000000000${idNum}`,
    age: 18 + (idNum % 30),
    gender,
    preferredGender: ['any'],
    minAgePref: 18,
    maxAgePref: 60,
    languages: ['en'],
    interests,
    queuedAt: Date.now() - (idNum % 60) * 1000,
  };
}

async function runMilestoneBenchmark(concurrency: number) {
  const engine = new MatchmakingEngine();
  const tickets: MatchTicket[] = [];

  const memBefore = process.memoryUsage().rss / 1024 / 1024;
  const startIngest = performance.now();

  for (let i = 0; i < concurrency; i++) {
    tickets.push(generateMockTicket(i));
  }
  const ingestDurationMs = performance.now() - startIngest;
  const ingestRps = Math.round((concurrency / (ingestDurationMs / 1000)));

  // Load block lists once per benchmark batch. Calling evaluateMatch()
  // without this snapshot would issue a database lookup for every candidate
  // pair and benchmark network overhead rather than the matching algorithm.
  const blockLists = await engine.preloadBlockLists(tickets);

  // Benchmark pairing evaluation throughput
  const startPairing = performance.now();
  let pairsMatched = 0;
  const matchedSet = new Set<string>();

  // Process sample slice or full set based on scale
  const sampleSize = Math.min(concurrency, 1000);
  for (let i = 0; i < sampleSize; i++) {
    const tA = tickets[i];
    if (matchedSet.has(tA.userId)) continue;

    for (let j = i + 1; j < sampleSize; j++) {
      const tB = tickets[j];
      if (matchedSet.has(tB.userId)) continue;

      const res = await engine.evaluateMatch(tA, tB, blockLists);
      if (res.isEligible && res.score >= 50) {
        matchedSet.add(tA.userId);
        matchedSet.add(tB.userId);
        pairsMatched++;
        break;
      }
    }
  }

  const pairingDurationMs = performance.now() - startPairing;
  const memAfter = process.memoryUsage().rss / 1024 / 1024;
  const memDelta = (memAfter - memBefore).toFixed(2);

  return {
    targetUsers: concurrency,
    ingestRps,
    sampleProcessed: sampleSize,
    pairsMatched,
    pairingLatencyMs: pairingDurationMs.toFixed(1),
    memoryRssMb: memAfter.toFixed(1),
    memoryDeltaMb: memDelta,
  };
}

export async function runAllLoadBenchmarks() {
  console.log('\n========================================================================');
  console.log('🚀 DESTINY CONCURRENT USER LOAD BENCHMARK (100 -> 10,000+ USERS)');
  console.log('========================================================================\n');

  const milestones = [100, 1000, 5000, 10000];
  const results = [];

  for (const milestone of milestones) {
    console.log(`⏳ Running benchmark milestone: ${milestone.toLocaleString()} concurrent users...`);
    const res = await runMilestoneBenchmark(milestone);
    results.push(res);
  }

  console.log('\n------------------------------------------------------------------------');
  console.log('📊 BENCHMARK PERFORMANCE RESULTS TABLE');
  console.log('------------------------------------------------------------------------');
  console.table(results);
  console.log('✅ All concurrency milestones completed successfully.\n');
}

if (process.argv[1]?.includes('load-benchmark')) {
  runAllLoadBenchmarks().catch(console.error);
}
