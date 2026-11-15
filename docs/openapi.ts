// OpenAPI description of the API, served at /api-docs
const json = { 'application/json': { schema: { type: 'object' } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const secured = [{ bearerAuth: [] }];

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Merchant KYC Onboarding API',
    version: '1.0.0',
    description:
      'Assessment project. All data is fictional. Log in with a demo user, then click Authorize and paste the token.',
  },
  servers: [{ url: 'http://localhost:3000' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
  paths: {
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in and get a JWT',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', example: 'maker1@demo.test' },
                  password: { type: 'string', example: 'Demo@1234' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Token returned' }, 401: { description: 'Invalid credentials' } },
      },
    },
    '/api/merchants': {
      post: {
        tags: ['Merchants'],
        summary: 'Create an application (MERCHANT, MAKER)',
        security: secured,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['businessName', 'businessType', 'contactEmail', 'contactPhone', 'pan'],
                properties: {
                  businessName: { type: 'string', example: 'Demo Traders' },
                  businessType: { type: 'string', enum: ['SOLE_PROPRIETOR', 'PARTNERSHIP', 'PRIVATE_LIMITED'] },
                  contactEmail: { type: 'string', example: 'shop@demo.test' },
                  contactPhone: { type: 'string', example: '9876543210' },
                  pan: { type: 'string', example: 'ABCDE1234F', description: 'Fictional PAN only' },
                  ownerEmail: { type: 'string', description: 'Required when a MAKER creates it' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created (PAN is masked in the response)' },
          400: { description: 'Validation failed' },
          409: { description: 'Duplicate PAN' },
        },
      },
    },
    '/api/merchants/{id}': {
      get: {
        tags: ['Merchants'],
        summary: 'Get an application (merchants see only their own)',
        security: secured,
        parameters: [idParam],
        responses: { 200: { description: 'OK' }, 404: { description: 'Not found, or not yours' } },
      },
      patch: {
        tags: ['Merchants'],
        summary: 'Edit details while DRAFT',
        security: secured,
        parameters: [idParam],
        requestBody: { content: json },
        responses: { 200: { description: 'Updated' }, 409: { description: 'Not a DRAFT' } },
      },
    },
    '/api/merchants/{id}/submit': {
      post: {
        tags: ['Merchants'],
        summary: 'Submit: DRAFT to SUBMITTED',
        security: secured,
        parameters: [idParam],
        responses: { 200: { description: 'Submitted' }, 409: { description: 'Invalid transition' } },
      },
    },
    '/api/merchants/{id}/review': {
      post: {
        tags: ['Review'],
        summary: 'Approve, reject or request changes (CHECKER, ADMIN)',
        security: secured,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['APPROVE', 'REJECT', 'REQUEST_CHANGES'] },
                  reason: { type: 'string', description: 'Required for REJECT and REQUEST_CHANGES' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Reviewed' },
          400: { description: 'Validation failed' },
          403: { description: 'Wrong role, or you worked on this application' },
          409: { description: 'Invalid transition, or KYC not verified' },
        },
      },
    },
    '/api/merchants/{id}/audit': {
      get: {
        tags: ['Review'],
        summary: 'Audit trail (MAKER, CHECKER, ADMIN)',
        security: secured,
        parameters: [idParam],
        responses: { 200: { description: 'List of audit events' } },
      },
    },
    '/api/kyc/verify': {
      post: {
        tags: ['KYC'],
        summary: 'Start KYC verification (MAKER, ADMIN)',
        description:
          'identityRef ending in 0 = SUCCESS, 1 = FAILED, 2 = PENDING, 3 = TIMEOUT (stored as UNKNOWN, never verified).',
        security: secured,
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['merchantId', 'identityRef'],
                properties: {
                  merchantId: { type: 'integer', example: 1 },
                  identityRef: { type: 'string', example: 'ID-1000' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Verification stored with provider reference' },
          200: { description: 'Idempotent replay of an earlier request' },
          409: { description: 'Merchant not SUBMITTED, or verification already in progress' },
        },
      },
    },
    '/api/kyc/status/{merchantId}': {
      get: {
        tags: ['KYC'],
        summary: 'Verification history (MAKER, CHECKER, ADMIN)',
        security: secured,
        parameters: [{ name: 'merchantId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'List of verifications' } },
      },
    },
    '/api/kyc/callback': {
      post: {
        tags: ['KYC'],
        summary: 'Signed provider callback',
        description:
          'Not called by users. The provider sends X-Signature = HMAC-SHA256 (hex) of the raw body using KYC_CALLBACK_SECRET. Use docs/examples.md to send a signed one.',
        parameters: [{ name: 'X-Signature', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['eventId', 'providerRef', 'outcome'],
                properties: {
                  eventId: { type: 'string', example: 'evt-1' },
                  providerRef: { type: 'string', example: 'PRV-0123456789abcdef' },
                  outcome: { type: 'string', enum: ['SUCCESS', 'FAILED'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'applied, duplicate or ignored' },
          401: { description: 'Invalid signature' },
          404: { description: 'Unknown provider reference' },
        },
      },
    },
    '/health': {
      get: { tags: ['System'], summary: 'Health check', responses: { 200: { description: 'ok' } } },
    },
  },
};