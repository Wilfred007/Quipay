import { rpc } from '@stellar/stellar-sdk';
import { sendWebhookNotification } from './delivery';
import { upsertStream, recordWithdrawal } from './db/queries';
import { getPool } from './db/pool';

const SOROBAN_RPC_URL = process.env.PUBLIC_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const QUIPAY_CONTRACT_ID = process.env.QUIPAY_CONTRACT_ID || '';

const server = new rpc.Server(SOROBAN_RPC_URL);

/**
 * Starts polling the Soroban RPC for Quipay contract events.
 */
export const startStellarListener = async () => {
    if (!QUIPAY_CONTRACT_ID) {
        console.warn('[Stellar Listener] ⚠️ QUIPAY_CONTRACT_ID is not set. The listener will simulate events for testing.');
        simulateEvents();
        return;
    }

    console.log(`[Stellar Listener] 📡 Listening for events on contract: ${QUIPAY_CONTRACT_ID}`);

    try {
        let latestLedger = await getLatestLedger();

        // Poll every 5 seconds
        setInterval(async () => {
            try {
                const currentLedger = await getLatestLedger();
                if (currentLedger <= latestLedger) return;

                const eventsResponse = await server.getEvents({
                    startLedger: latestLedger + 1,
                    filters: [
                        {
                            type: 'contract',
                            contractIds: [QUIPAY_CONTRACT_ID]
                        }
                    ],
                    limit: 100
                });

                eventsResponse.events.forEach(event => {
                    parseAndDeliverEvent(event);
                });

                latestLedger = currentLedger;
            } catch (err: any) {
                console.error(`[Stellar Listener] Error polling events: ${err.message}`);
            }
        }, 5000);
    } catch (err: any) {
        console.error(`[Stellar Listener] Initialization failed: ${err.message}`);
    }
};

const getLatestLedger = async (): Promise<number> => {
    const health = await server.getLatestLedger();
    return health.sequence;
};

const parseAndDeliverEvent = async (event: rpc.Api.EventResponse) => {
    try {
        const topics = event.topic;
        if (!topics || topics.length === 0) return;

        const topicString = topics[0].toXDR('base64');

        let eventType = 'unknown';
        if (topicString.includes('withdrawal') || topicString.includes('Withdraw') || topicString.includes('withdraw')) {
            eventType = 'withdrawal';
        } else if (topicString.includes('stream') || topicString.includes('Stream') || topicString.includes('create')) {
            eventType = 'new_stream';
        } else if (topicString.includes('cancel') || topicString.includes('Cancel')) {
            eventType = 'stream_cancelled';
        } else {
            eventType = 'generic_contract_event';
        }

        const payload = {
            id: event.id,
            ledger: event.ledger,
            contractId: event.contractId,
            type: event.type,
            eventType: eventType
        };

        // ── Persist to analytics DB (fire-and-forget; doesn't block webhook delivery) ──
        if (getPool()) {
            if (eventType === 'new_stream') {
                upsertStream({
                    streamId: event.ledger, // real parse would extract stream_id from XDR value
                    employer: event.contractId?.toString() ?? '',
                    worker: event.contractId?.toString() ?? '',
                    totalAmount: 0n,
                    withdrawnAmount: 0n,
                    startTs: 0,
                    endTs: 0,
                    status: 'active',
                    ledger: event.ledger,
                }).catch((e: Error) => console.error('[Stellar Listener] DB upsert failed:', e.message));
            } else if (eventType === 'withdrawal') {
                recordWithdrawal({
                    streamId: event.ledger,
                    worker: event.contractId?.toString() ?? '',
                    amount: 0n,
                    ledger: event.ledger,
                    ledgerTs: event.ledger,
                }).catch((e: Error) => console.error('[Stellar Listener] DB withdrawal record failed:', e.message));
            }
        }

        // ── Webhook delivery (unchanged) ──
        if (eventType !== 'unknown') {
            sendWebhookNotification(eventType, payload);
        }

    } catch (e) {
        console.error('[Stellar Listener] Failed to parse event topic', e);
    }
};

// Simulation fallback for integration testing without a real contract
const simulateEvents = () => {
    setInterval(() => {
        const simulatedEventTypes = ['withdrawal', 'new_stream'];
        const randomType = simulatedEventTypes[Math.floor(Math.random() * simulatedEventTypes.length)];

        const payload = {
            id: `sim-${Date.now()}`,
            ledger: Math.floor(Math.random() * 100000) + 1000000,
            contractId: 'C_SIMULATED_QUIPAY_CONTRACT',
            type: 'contract',
            eventType: randomType,
            amount: Math.floor(Math.random() * 500) + 50,
            asset: 'USDC'
        };

        console.log(`[Stellar Listener] 🧪 Simulating ${randomType} event...`);
        sendWebhookNotification(randomType, payload);
    }, 15000); // Simulate an event every 15 seconds
};
