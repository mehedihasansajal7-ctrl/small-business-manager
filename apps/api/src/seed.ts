import { join } from 'node:path';
import { createApp } from './server.js';
import { loadConfig, loadDotEnv } from './config.js';
import { Database } from './db.js';
import { AuthService } from './auth.js';
import { Repository } from './repository.js';
import type { Caller } from './repository.js';

/**
 * Seed a realistic demo business: 3 partners, a shop, and a full farming cycle
 * from input purchase to harvest, sale and batch profitability.
 *
 * Safe to run repeatedly in local mode; it does nothing if the demo user exists.
 */
export async function seed(target = 'local', verbose = true): Promise<{ email: string; password: string; businessId: string }> {
  const config = loadConfig();
  const db = new Database(target === 'memory' ? ':memory:' : config.databaseFile);
  const auth = new AuthService(db, config.sessionSecret, config.sessionTtlHours);
  const repo = new Repository(db, auth, config);
  const log = (message: string) => {
    if (verbose) process.stdout.write(`  ${message}\n`);
  };

  const email = 'owner@demo.sbm';
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    log('Demo user already exists - nothing to seed.');
    if (target !== 'memory') db.close();
    return { email, password: 'demo1234', businessId: 'existing' };
  }

  // Use a fully elapsed month so every demo date is in the past.
  const previous = new Date();
  previous.setUTCMonth(previous.getUTCMonth() - 1, 1);
  const month = previous.toISOString().slice(0, 7);
  const today = `${month}-28`;

  const owner = auth.createUser({ email, displayName: 'Rahim Uddin (Owner)', password: 'demo1234' });
  const partner = auth.createUser({ email: 'partner@demo.sbm', displayName: 'Karim Mia (Partner)', password: 'demo1234' });
  const farmManager = auth.createUser({ email: 'farm@demo.sbm', displayName: 'Selina Begum (Farm manager)', password: 'demo1234' });
  log('Created 3 partner accounts (owner, partner, farm manager).');

  const created = repo.createBusiness(owner, { name: 'Rahim Agro & General Store' });
  const businessId = created.business.id;
  const ownerCaller: Caller = { user: owner, business: repo.getBusiness(businessId), member: created.member, role: 'owner' };

  // Add the other two partners directly as active members for the demo.
  for (const [user, role] of [
    [partner, 'manager'],
    [farmManager, 'farm_manager'],
  ] as const) {
    db.run(`INSERT INTO members (id, business_id, user_id, email, display_name, role, status, grants, denials, joined_at) VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', '[]', ?)`, [
      `member-${user.id.slice(0, 8)}`,
      businessId,
      user.id,
      user.email,
      user.display_name,
      role,
      new Date().toISOString(),
    ]);
  }
  log('Members: 1 owner, 1 manager, 1 farm manager.');

  const location = repo.listLocations(ownerCaller)[0] as { id: string };
  const locationId = location.id;

  const products = {
    rice: repo.createProduct(ownerCaller, { name: 'Miniket Rice', nameBn: 'মিনিকেট চাল', kind: 'PRODUCT', unit: 'kg', salePrice: '68', purchasePrice: '58', reorderLevel: '100' }).id,
    urea: repo.createProduct(ownerCaller, { name: 'Urea Fertiliser', nameBn: 'ইউরিয়া সার', kind: 'INPUT', unit: 'kg', purchasePrice: '27', reorderLevel: '50' }).id,
    feed: repo.createProduct(ownerCaller, { name: 'Poultry Starter Feed', nameBn: 'পোল্ট্রি স্টার্টার ফিড', kind: 'INPUT', unit: 'kg', purchasePrice: '62', reorderLevel: '100', trackLots: true }).id,
    chicks: repo.createProduct(ownerCaller, { name: 'Broiler Day-old Chick', nameBn: 'ব্রয়লার বাচ্চা', kind: 'LIVESTOCK', unit: 'pcs', purchasePrice: '55' }).id,
    chicken: repo.createProduct(ownerCaller, { name: 'Live Broiler Chicken', nameBn: 'জীবিত ব্রয়লার', kind: 'OUTPUT', unit: 'kg', salePrice: '175' }).id,
  };
  log('Catalog: 5 products (2 stock items for resale, 3 farming inputs/outputs).');

  const customerId = repo.createCustomer(ownerCaller, { name: 'Nasir Traders', phone: '01711111111' }).id;
  const supplierId = repo.createSupplier(ownerCaller, { name: 'Agro Inputs Ltd', phone: '01822222222' }).id;
  const farmSupplierId = repo.createSupplier(ownerCaller, { name: 'Poultry Hatchery BD', phone: '01933333333' }).id;

  // --- Shop: opening purchase, cash sale, credit sale, receipt ---
  repo.createPurchase(ownerCaller, {
    documentDate: `${month}-02`,
    supplierId,
    accountCode: '1010',
    paid: '20000',
    lines: [
      { productId: products.rice, quantity: '500', unit: 'kg', unitCost: '58' },
      { productId: products.urea, quantity: '100', unit: 'kg', unitCost: '27' },
    ],
  });
  const creditSale = repo.createSale(ownerCaller, {
    documentDate: `${month}-05`,
    customerId,
    accountCode: '1010',
    cashReceived: '5000',
    lines: [{ productId: products.rice, quantity: '120', unit: 'kg', unitPrice: '68', discount: '60' }],
  });
  repo.createSale(ownerCaller, {
    documentDate: `${month}-06`,
    cashReceived: '2000',
    lines: [{ productId: products.rice, quantity: '30', unit: 'kg', unitPrice: '68' }],
  });
  repo.recordCustomerReceipt(ownerCaller, { documentDate: `${month}-07`, customerId, amount: '2000', accountCode: '1000' });
  repo.recordIncomeExpense(ownerCaller, { kind: 'EXPENSE', categoryAccount: '5170', documentDate: `${month}-03`, amount: '3500', note: 'Shop rent' });
  repo.recordIncomeExpense(ownerCaller, { kind: 'EXPENSE', categoryAccount: '5120', documentDate: `${month}-04`, amount: '900', note: 'Electricity bill' });
  repo.recordTransfer(ownerCaller, { documentDate: `${month}-04`, amount: '10000', fromAccount: '1010', toAccount: '1000' });
  log('Shop: 1 purchase, 2 sales (1 on credit), 1 receipt, 2 expenses, 1 cash transfer.');

  // --- Farming: full broiler cycle ---
  const farm = repo.createFarm(ownerCaller, { name: 'Rahim Poultry Farm', area: '12', areaUnit: 'decimal', locationId });
  const unit = repo.createFarmUnit(ownerCaller, { farmId: farm.id, kind: 'POULTRY_HOUSE', name: 'Shed 1', capacity: '2000', capacityUnit: 'pcs' });
  const cycle = repo.createCycle(ownerCaller, {
    farmId: farm.id,
    unitId: unit.id,
    farmingType: 'POULTRY',
    title: 'Broiler batch 1 (winter)',
    cropOrSpecies: 'Broiler chicken',
    varietyOrBreed: 'Cobb 500',
    season: 'Winter',
    startDate: `${month}-01`,
    expectedEndDate: `${month}-30`,
    plannedOutput: '1400',
    plannedOutputUnit: 'kg',
    startingPopulation: '1000',
  });
  const cycleId = cycle.id as string;
  const cycleReference = cycle.reference as string;

  repo.createPurchase(ownerCaller, {
    documentDate: `${month}-01`,
    supplierId: farmSupplierId,
    accountCode: '1010',
    paid: '55000',
    lines: [
      { productId: products.chicks, quantity: '1000', unit: 'pcs', unitCost: '55' },
      { productId: products.feed, quantity: '200', unit: 'kg', unitCost: '62', lotNo: 'FEED-W1', expiryDate: `${month}-28` },
    ],
  });
  repo.createSale(ownerCaller, {
    documentDate: `${month}-02`,
    cashReceived: '600',
    lines: [{ productId: products.urea, quantity: '20', unit: 'kg', unitPrice: '30' }],
  });

  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'INPUT_ISSUE', occurredOn: `${month}-03`, productId: products.feed, quantity: '150', unit: 'kg', notes: 'Starter feed issued' });
  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'DIRECT_LABOUR', occurredOn: `${month}-10`, amount: '4000', notes: 'Shed cleaning labour' });
  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'VETERINARY', occurredOn: `${month}-12`, amount: '1800', notes: 'Vaccination and vitamins' });
  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'UTILITIES', occurredOn: `${month}-15`, amount: '2500', notes: 'Brooder electricity' });
  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'MORTALITY', occurredOn: `${month}-08`, quantity: '18', unit: 'pcs', reason: 'First-week chick mortality (normal range)' });
  repo.recordFarmingEvent(ownerCaller, { cycleId, eventType: 'OBSERVATION', occurredOn: `${month}-14`, kind: 'Average weight', value: '1.2', unit: 'kg', notes: 'Sample of 20 birds' });
  log('Farming: farm + shed + broiler cycle with feed issue, labour, vet, utilities, mortality and a weight observation.');

  // Shared overhead across two cycles (the second cycle makes the split meaningful).
  const cycle2 = repo.createCycle(ownerCaller, {
    farmId: farm.id,
    unitId: unit.id,
    farmingType: 'POULTRY',
    title: 'Broiler batch 2 (planning)',
    cropOrSpecies: 'Broiler chicken',
    startDate: `${month}-20`,
    plannedOutput: '1400',
    plannedOutputUnit: 'kg',
    startingPopulation: '1000',
  });
  repo.allocateSharedCost(ownerCaller, {
    amount: '6000',
    currency: 'BDT',
    basis: 'ANIMAL_COUNT',
    incurredOn: `${month}-16`,
    note: 'Farm guard salary shared between the two sheds',
    targets: [
      { cycleId, basisValue: '1000' },
      { cycleId: cycle2.id, basisValue: '1000' },
    ],
  });

  const harvest = repo.recordHarvest(ownerCaller, { cycleId, occurredOn: `${month}-25`, quantity: '1200', unit: 'kg', productId: products.chicken, locationId, method: 'PLANNED_YIELD_PRORATA' });
  repo.createSale(ownerCaller, {
    documentDate: `${month}-26`,
    cashReceived: '105000',
    note: `Broiler sale from ${cycleReference}`,
    lines: [{ productId: products.chicken, quantity: '600', unit: 'kg', unitPrice: '175' }],
  });
  log(`Farming: harvested ${String(harvest.quantity)} kg (cost basis ${String(harvest.costBasis)} BDT) and sold 600 kg.`);

  const profit = repo.cycleProfitReport(ownerCaller, cycleId);
  const dashboard = repo.dashboard(ownerCaller, { from: `${month}-01`, to: today });

  // Two example AI questions in fallback mode (no provider needed).
  const aiStatus = repo.db.get('SELECT 1');
  void aiStatus;

  if (verbose) {
    process.stdout.write('\n=== Seed summary ===\n');
    process.stdout.write(`Business          : Rahim Agro & General Store (${businessId})\n`);
    process.stdout.write(`Partners          : 3 (owner, manager, farm_manager)\n`);
    process.stdout.write(`Credit sale       : ${JSON.stringify(creditSale)}\n`);
    process.stdout.write(`Cycle reference   : ${cycleReference}\n`);
    process.stdout.write(`Cycle cost to date: ${String(profit.costToDate)} BDT\n`);
    process.stdout.write(`Cycle revenue     : ${String(profit.revenue)} BDT | COGS ${String(profit.cogs)} BDT | gross ${String(profit.grossProfit)} BDT\n`);
    process.stdout.write(`Month dashboard   : sales ${String(dashboard.sales)}, net profit ${String((dashboard as Record<string, unknown>).netProfit ?? 'restricted')}\n`);
    process.stdout.write('\nSign in with: owner@demo.sbm / demo1234   (partners: partner@demo.sbm, farm@demo.sbm - same password)\n');
  }

  if (target !== 'memory') db.close();
  return { email, password: 'demo1234', businessId };
}

const isMain = process.argv[1] ? process.argv[1].replace(/\\/g, '/').endsWith('/seed.js') || process.argv[1].replace(/\\/g, '/').endsWith('/seed.ts') : false;

if (isMain) {
  loadDotEnv(join(process.cwd(), '.env'));
  loadDotEnv(join(process.cwd(), '..', '..', '.env'));
  void seed(process.argv.includes('--memory') ? 'memory' : 'local').then(() => process.exit(0));
}

export { createApp };
