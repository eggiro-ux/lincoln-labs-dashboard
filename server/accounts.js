// ─── QBO Account Name Mapping ─────────────────────────────────────────────────
// These must match EXACTLY the account names in your QuickBooks chart of accounts.
// If an account name changes in QBO, update it here.

const ACCOUNT_MAP = {
  // Civille: sum of both sub-accounts
  civille: {
    label: 'Civille + Phantom Copy',
    color: '#22c55e',
    accounts: ['Civille', 'Phantom Copy'],
    type: 'income',
  },

  // AwesomeAPI
  awesomeapi: {
    label: 'AwesomeAPI',
    color: '#eab308',
    accounts: ['AwesomeAPI'],
    type: 'income',
  },

  // Truss Client Salaries delta: income minus COGS expense
  truss_sal_delta: {
    label: 'Truss Client Salaries (Income − Exp)',
    color: '#a855f7',
    accounts: ['Truss Client Salaries'],       // income account
    expenseAccounts: ['Truss - Client Salaries Expense'], // COGS account to subtract
    type: 'delta',
  },

  // Truss Service Fees + Recruitment combined
  truss_svc_rec: {
    label: 'Truss Svc Fees + Recruitment',
    color: '#3b82f6',
    accounts: ['Truss Service Fees', 'Truss Recruitment'],
    type: 'income',
  },

  // Lincoln Labs: sum of all sub-accounts
  lincoln_labs: {
    label: 'Lincoln Labs Total',
    color: '#e5e5e5',
    accounts: ['Consulting', 'Credit Card Fees', 'Rental Income (from Subletting)', 'Royalties'],
    type: 'income',
  },
};

module.exports = ACCOUNT_MAP;
