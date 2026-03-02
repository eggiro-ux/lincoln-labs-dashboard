// ─── QBO Account Name Mapping ─────────────────────────────────────────────────
// These must match EXACTLY the account names in your QuickBooks chart of accounts.
// If an account name changes in QBO, update it here.

const ACCOUNT_MAP = {
  // Civille: read the QBO section Summary row rather than summing sub-accounts,
  // because "Civille" is a Section not a Data row and its children may vary.
  civille: {
    label: 'Civille + Phantom Copy',
    color: '#22c55e',
    accounts: ['Total for Civille'],
    type: 'income',
  },

  // AwesomeAPI — QBO may return with or without a space; include both variants
  awesomeapi: {
    label: 'AwesomeAPI',
    color: '#eab308',
    accounts: ['AwesomeAPI', 'Awesome API'],
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

  // Lincoln Labs: read the QBO section Summary row — the individual sub-accounts
  // (Consulting, Royalties, etc.) were previously missing from the traversal.
  lincoln_labs: {
    label: 'Lincoln Labs Total',
    color: '#e5e5e5',
    accounts: ['Total for Lincoln Labs'],
    type: 'income',
  },
};

module.exports = ACCOUNT_MAP;
