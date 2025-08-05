# Fridgy Authentication Setup

## 🗄️ Database Setup

### 1. Create Users Table in Supabase

1. **Go to your Supabase Dashboard**: https://supabase.com/dashboard
2. **Select your Fridgy project**
3. **Go to SQL Editor**
4. **Copy and paste the contents of `supabase_setup.sql`**
5. **Run the SQL commands**

This will create:
- `users` table with proper structure
- Indexes for performance
- Row Level Security (RLS) policies
- Automatic timestamp updates

### 2. Verify Table Creation

After running the SQL, you should see:
- `users` table in your database
- Proper RLS policies enabled
- Index on email field

## 🔧 Backend Setup

### 1. Environment Variables

Your `.env` file should contain:
```
SUPABASE_URL=https://aimvjpndmipmtavpmjnn.supabase.co
SUPABASE_ANON_KEY=your-anon-key
JWT_SECRET=your-super-secret-jwt-key-change-in-production
```

### 2. Start the Backend

```bash
cd Backend
npm install
npm run dev
```

## 🧪 Test the API

### 1. Test Backend Connection
```bash
curl http://localhost:5000/api/test
```

### 2. Test User Registration
```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "email": "john@example.com",
    "password": "password123"
  }'
```

### 3. Test User Login
```bash
curl -X POST http://localhost:5000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "password123"
  }'
```

## 📡 API Endpoints

### Authentication Endpoints

- `POST /api/auth/signup` - User registration
- `POST /api/auth/signin` - User login
- `GET /api/auth/me` - Get current user (requires token)

### Request/Response Format

#### Signup Request:
```json
{
  "firstName": "John",
  "email": "john@example.com",
  "password": "password123"
}
```

#### Signup Response:
```json
{
  "success": true,
  "message": "User created successfully",
  "user": {
    "id": "uuid",
    "email": "john@example.com",
    "firstName": "John",
    "createdAt": "2024-08-04T..."
  },
  "token": "jwt-token"
}
```

## 🔒 Security Features

- **Password Hashing**: bcrypt with 12 salt rounds
- **JWT Tokens**: 7-day expiration
- **Input Validation**: Email, password, and name validation
- **Row Level Security**: Database-level security policies
- **Error Handling**: Proper error responses

## 🚀 Next Steps

1. **Test the backend endpoints**
2. **Update frontend to use real API**
3. **Add logout functionality**
4. **Implement password reset**
5. **Add user profile management** 