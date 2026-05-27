const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin SDK
// Expects FIREBASE_SERVICE_ACCOUNT_JSON env variable or automatic local initialization
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  admin.initializeApp();
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
// Webhook endpoint needs raw body for signature verification
app.use('/webhook/cashfree', express.raw({ type: 'application/json' }));

// -------------------------------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// -------------------------------------------------------------------------
async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decodedToken.uid };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
}

// -------------------------------------------------------------------------
// HELPERS & CONSTANTS
// -------------------------------------------------------------------------
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || 'TEST_APP_ID';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'TEST_SECRET_KEY';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'sandbox'; // 'sandbox' or 'production'

const CASHFREE_URLS = {
  sandbox: 'https://sandbox.cashfree.com/pg/orders',
  production: 'https://api.cashfree.com/pg/orders'
};

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function calculateXP(rank, kills) {
  const rankBonus = rank === 1 ? 100 : rank === 2 ? 50 : rank === 3 ? 30 : 10;
  return rankBonus + (kills * 15);
}

// -------------------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------------------

// 1. AUTH SIGNUP
app.post('/auth/signup', async (req, res) => {
  const { uid, username, email, referralCode } = req.body;

  if (!uid || !username || !email) {
    return res.status(400).json({ error: 'Missing required fields: uid, username, email' });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await userRef.get();

    if (userSnapshot.exists) {
      return res.status(200).json({ message: 'User already exists', user: userSnapshot.data() });
    }

    let referredBy = null;
    if (referralCode) {
      const referralQuery = await db.collection('users')
        .where('referralCode', '==', referralCode)
        .limit(1)
        .get();
      if (!referralQuery.empty) {
        referredBy = referralQuery.docs[0].id;
      }
    }

    const newUser = {
      username,
      email,
      wallet: 0,
      totalXP: 0,
      joinedMatches: [],
      referralCode: generateReferralCode(),
      referredBy,
      matchesPlayed: 0,
      totalKills: 0,
      dailyStreak: 0,
      isVIP: false
    };

    await userRef.set(newUser);
    return res.status(201).json({ message: 'User created successfully', user: newUser });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 2. MATCH JOIN
app.post('/match/join', authenticateToken, async (req, res) => {
  const { matchId, gameUids } = req.body;
  const userUid = req.user.uid;

  if (!matchId || !Array.isArray(gameUids) || ![1, 2, 4].includes(gameUids.length)) {
    return res.status(400).json({ error: 'Invalid matchId or gameUids. Squad size must be 1, 2, or 4.' });
  }

  const matchRef = db.collection('matches').doc(matchId);
  const userRef = db.collection('users').doc(userUid);
  const teamRef = db.collection('matches').doc(matchId).collection('teams').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) {
        throw new Error('Match does not exist');
      }
      const matchData = matchDoc.data();

      if (matchData.status !== 'upcoming') {
        throw new Error('Match is not open for registration');
      }

      const requestedSlots = gameUids.length;
      if ((matchData.joinedCount || 0) + requestedSlots > matchData.maxPlayers) {
        throw new Error('Not enough slots available in this match');
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User data profile not found');
      }
      const userData = userDoc.data();

      if (userData.joinedMatches && userData.joinedMatches.includes(matchId)) {
        throw new Error('User has already joined this match');
      }

      const entryFee = matchData.entryFee || 0;
      if (userData.wallet < entryFee) {
        throw new Error('Insufficient wallet balance');
      }

      // Check for global collision of gameUids across existing teams inside this match
      const existingTeamsQuery = await db.collection(`matches/${matchId}/teams`).get();
      const allocatedGameUids = new Set();
      existingTeamsQuery.forEach(doc => {
        const team = doc.data();
        if (team.gameUids && Array.isArray(team.gameUids)) {
          team.gameUids.forEach(id => allocatedGameUids.add(id));
        }
      });

      for (const id of gameUids) {
        if (allocatedGameUids.has(id)) {
          throw new Error(`Game UID ${id} is already registered in this match by another team`);
        }
      }

      const teamDoc = await transaction.get(teamRef);
      if (teamDoc.exists) {
        throw new Error('Team registration slot already occupied by this owner context');
      }

      // Execute atomic debit and state transition mapping
      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId: userUid,
        type: 'MATCH_ENTRY',
        amount: entryFee,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      transaction.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(requestedSlots)
      });

      transaction.set(teamRef, {
        ownerUid: userUid,
        ownerUsername: userData.username,
        gameUids: gameUids
      });

      return { success: true };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// 3. DAILY REWARDS
app.post('/rewards/daily', authenticateToken, async (req, res) => {
  const userUid = req.user.uid;
  const userRef = db.collection('users').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User profile completely missing');
      }
      const userData = userDoc.data();

      // Look up previous transaction timeline to guard the 24 hour state threshold
      const recentRewards = await db.collection('transactions')
        .where('userId', '==', userUid)
        .where('type', '==', 'DAILY_REWARD')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      const now = Date.now();
      if (!recentRewards.empty) {
        const lastRewardTime = recentRewards.docs[0].data().timestamp.toDate().getTime();
        if (now - lastRewardTime < 24 * 60 * 60 * 1000) {
          throw new Error('Daily reward already claimed within the last 24 hours');
        }
      }

      const rewardAmount = 10; // Standard nominal platform base distribution allocation
      const txRef = db.collection('transactions').doc();

      transaction.set(txRef, {
        userId: userUid,
        type: 'DAILY_REWARD',
        amount: rewardAmount,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(rewardAmount),
        dailyStreak: admin.firestore.FieldValue.increment(1)
      });

      return { success: true, rewardAmount };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// 4. CREATE ORDER (CASHFREE INTEGRATION)
app.post('/wallet/createOrder', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  const userUid = req.user.uid;

  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid numeric transaction amount is mandatory' });
  }

  try {
    const userDoc = await db.collection('users').doc(userUid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User mapping data layer target structural node not found' });
    }
    const userData = userDoc.data();

    const orderId = `order_${crypto.randomBytes(6).toString('hex')}`;
    const dynamicUrl = CASHFREE_URLS[CASHFREE_ENV];

    // Node environment structural mapping request payload design parameters
    const response = await fetch(dynamicUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: parseFloat(amount),
        order_currency: 'INR',
        customer_details: {
          customer_id: userUid,
          customer_email: userData.email || 'no-email@platform.com',
          customer_phone: userData.phone || '9999999999'
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: 'Cashfree Gateway integration fault response state caught', details: data });
    }

    // Capture payment intents securely without updating transactional logic state models until validation verified
    await db.collection('transactions').doc(orderId).set({
      userId: userUid,
      type: 'DEPOSIT',
      amount: parseFloat(amount),
      status: 'PENDING',
      orderId: orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      orderId: orderId,
      paymentSessionId: data.payment_session_id,
      cfOrderId: data.cf_order_id
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 5. CASHFREE WEBHOOK VERIFICATION (IDEMPOTENT STATUS BALANCING ENGINE)
app.post('/webhook/cashfree', async (req, res) => {
  // Webhook requests require absolute body validation mechanisms
  const rawBody = req.body.toString('utf8');
  const ts = req.headers['x-webhook-timestamp'];
  const signature = req.headers['x-webhook-signature'];

  if (!ts || !signature) {
    return res.status(400).send('Missing payload structural transaction headers');
  }

  // Construct precise payload authentication string structures
  const signedPayload = ts + rawBody;
  const expectedSignature = crypto
    .createHmac('sha256', CASHFREE_SECRET_KEY)
    .update(signedPayload)
    .digest('base64');

  if (signature !== expectedSignature) {
    return res.status(400).send('Webhook authentication cryptographic validation mismatch failed');
  }

  let eventData;
  try {
    eventData = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Malformed JSON packet schema payload structural nodes');
  }

  const { data } = eventData;
  if (!data || !data.order || !data.payment) {
    return res.status(200).send('Ignored: Core functional identity data components missing or unparseable');
  }

  const orderId = data.order.order_id;
  const webhookAmount = data.order.order_amount;
  const paymentStatus = data.payment.payment_status;

  try {
    const txRef = db.collection('transactions').doc(orderId);
    
    await db.runTransaction(async (transaction) => {
      const txDoc = await transaction.get(txRef);
      if (!txDoc.exists) {
        throw new Error(`Transaction entry tracking instance targeting record mapping node ${orderId} missing`);
      }

      const txData = txDoc.data();
      if (txData.status !== 'PENDING') {
        // Already mutations complete state tracking layer (Ensures webhook execution logic is idempotent)
        return;
      }

      if (parseFloat(txData.amount) !== parseFloat(webhookAmount)) {
        throw new Error('Cryptographic anomaly identified: Numerical value parameters mismatches detected');
      }

      if (paymentStatus === 'SUCCESS') {
        const userRef = db.collection('users').doc(txData.userId);
        transaction.update(userRef, {
          wallet: admin.firestore.FieldValue.increment(txData.amount)
        });
        transaction.update(txRef, { status: 'SUCCESS' });
      } else if (['FAILED', 'CANCELLED', 'FLAGGED'].includes(paymentStatus)) {
        transaction.update(txRef, { status: 'FAILED' });
      }
    });

    return res.status(200).send('Webhook resolution states balanced successfully');
  } catch (error) {
    return res.status(500).send(`Internal Webhook Processing Fault: ${error.message}`);
  }
});

// 6. WALLET WITHDRAWAL
app.post('/wallet/withdraw', authenticateToken, async (req, res) => {
  const { amount, upiId } = req.body;
  const userUid = req.user.uid;

  if (!amount || isNaN(amount) || parseFloat(amount) <= 0 || !upiId) {
    return res.status(400).json({ error: 'Missing parameter entries or invalid negative value constraints input' });
  }

  const numericAmount = parseFloat(amount);
  const userRef = db.collection('users').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User context profile instance validation failed');
      }
      const userData = userDoc.data();

      if (userData.wallet < numericAmount) {
        throw new Error('Insufficient wallet balances available to fulfill allocation operations');
      }

      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId: userUid,
        type: 'WITHDRAWAL',
        amount: numericAmount,
        status: 'PENDING',
        upiId: upiId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Debit immediate isolation balance constraints allocation tracking models
      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-numericAmount)
      });

      return { success: true, message: 'Withdrawal processing locked safely. Admin oversight manual audit pending.' };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// 7. ADMIN MATCH PRIZE & XP DISTRIBUTION
app.post('/admin/match/distribute', async (req, res) => {
  const { matchId, gameUid, rank, kills } = req.body;

  // Manual auth guard structure layer for internal control logic validation nodes
  // Typically uses authorization key mappings to enforce absolute control isolation paradigms
  const adminSecret = req.headers['x-admin-secret'];
  if (process.env.ADMIN_SECRET_KEY && adminSecret !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Access denied: Admin isolation token signature mismatch' });
  }

  if (!matchId || gameUid === undefined || !rank || kills === undefined) {
    return res.status(400).json({ error: 'Missing mandatory administrative distribution parameter components' });
  }

  try {
    const matchRef = db.collection('matches').doc(matchId);
    
    // Scan inside collection mapping arrays subnodes to find registered team group
    const teamsSnapshot = await db.collection(`matches/${matchId}/teams`)
      .where('gameUids', 'array-contains', gameUid)
      .limit(1)
      .get();

    if (teamsSnapshot.empty) {
      return res.status(404).json({ error: 'No team found holding game identity target metrics matching selection parameters' });
    }

    const teamDoc = teamsSnapshot.docs[0];
    const teamData = teamDoc.data();
    const ownerUid = teamData.ownerUid;

    const userRef = db.collection('users').doc(ownerUid);

    const result = await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) {
        throw new Error('Target match deployment document lookup failure across state paths');
      }
      const matchData = matchDoc.data();

      // Check optimization state metrics to confirm no duplicate distribution routines can execute
      if (matchData.prizeDistributed === true) {
        throw new Error('Distribution operations for this match instance are already closed globally');
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('Owner data profile target validation paths are missing unmapped');
      }

      const perKillRate = matchData.perKillRate || 0;
      const rankPrizes = matchData.rankPrizes || {};
      const rankPrize = rankPrizes[rank.toString()] || 0;

      const totalPrizeCalculated = (kills * perKillRate) + rankPrize;
      const totalXpCalculated = calculateXP(parseInt(rank), parseInt(kills));

      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId: ownerUid,
        type: 'MATCH_REWARD',
        amount: totalPrizeCalculated,
        matchId: matchId,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(totalPrizeCalculated),
        totalXP: admin.firestore.FieldValue.increment(totalXpCalculated),
        matchesPlayed: admin.firestore.FieldValue.increment(1),
        totalKills: admin.firestore.FieldValue.increment(parseInt(kills))
      });

      // Update match record to lock execution flags completely
      transaction.update(matchRef, {
        prizeDistributed: true,
        status: 'completed'
      });

      return {
        success: true,
        ownerUid,
        prizeCredited: totalPrizeCalculated,
        xpEarned: totalXpCalculated
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Global Express execution listening state initialization mapping metrics
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Esports engine backend server successfully routing traffic on system port: ${PORT}`);
});

module.exports = app;
