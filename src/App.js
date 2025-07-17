# --- Part 1: Final Backend Server (tax_analyzer_backend.py) ---
# This file should be in your GitHub repository connected to Render.

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import fitz
import requests
import json
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
CORS(app)

# --- Database Connection Details (from Environment Variables) ---
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_NAME = os.getenv("DB_NAME")
DB_SSL_MODE = os.getenv("DB_SSL_MODE", "require")

# --- Gemini API Details (from Environment Variables) ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"

def get_db_connection():
    """Establishes a secure connection to the PostgreSQL database."""
    if not all([DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME]):
        print("FATAL ERROR: Database environment variables are not fully set.")
        return None
    try:
        conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, user=DB_USER,
            password=DB_PASSWORD, dbname=DB_NAME, sslmode=DB_SSL_MODE,
            cursor_factory=RealDictCursor
        )
        return conn
    except psycopg2.Error as e:
        print(f"DATABASE CONNECTION FAILED: {e}")
        return None

def initialize_database():
    """Creates or alters the users table to include new fields."""
    conn = get_db_connection()
    if not conn:
        print("Could not initialize database, connection failed.")
        return

    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    first_name VARCHAR(100) NOT NULL,
                    last_name VARCHAR(100) NOT NULL,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    dob DATE,
                    mobile_number VARCHAR(25)
                );
            """)
            conn.commit()
            print("Database schema verified successfully.")
    except psycopg2.Error as e:
        print(f"DATABASE SCHEMA ERROR: {e}")
    finally:
        if conn:
            conn.close()

def extract_text_from_pdf(pdf_bytes):
    """Extracts text from a PDF."""
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            return "".join(page.get_text() for page in doc)
    except Exception as e:
        print(f"PDF EXTRACTION ERROR: {e}")
        return None

def call_gemini_api(text):
    """Calls the Gemini API to summarize the extracted text."""
    prompt = f"""
    You are a meticulous tax notice analyst. Your task is to analyze the following text from an IRS notice and extract specific information into a single, well-structured JSON object. Do not omit any fields. If a field's information cannot be found, return an empty string "" for that value.

    Based on the text provided, find and populate the following JSON structure:
    {{
      "noticeType": "The notice code, like 'CP23' or 'CP503C'",
      "noticeFor": "The full name of the taxpayer, e.g., 'JAMES & KAREN Q. HINDS'",
      "address": "The full address of the taxpayer, with newlines as \\n, e.g., '22 BOULDER STREET\\nHANSON, CT 00000-7253'",
      "ssn": "The Social Security Number, masked, e.g., 'nnn-nn-nnnn'",
      "amountDue": "The final total amount due as a string, e.g., '$500.73'",
      "payBy": "The payment due date as a string, e.g., 'February 20, 2018'",
      "breakdown": [
        {{ "item": "The first line item in the billing summary", "amount": "Its corresponding amount" }},
        {{ "item": "The second line item", "amount": "Its amount" }}
      ],
      "noticeMeaning": "A concise, 2-line professional explanation of what this specific notice type means.",
      "whyText": "A paragraph explaining exactly why the user received this notice, based on the text.",
      "fixSteps": {{
        "agree": "A string explaining the steps to take if the user agrees.",
        "disagree": "A string explaining the steps to take if the user disagrees."
      }},
      "paymentOptions": {{
        "online": "The URL for online payments, e.g., 'www.irs.gov/payments'",
        "mail": "Instructions for paying by mail.",
        "plan": "The URL for setting up a payment plan, e.g., 'www.irs.gov/paymentplan'"
      }},
      "helpInfo": {{
        "contact": "The primary contact phone number for questions.",
        "advocate": "Information about the Taxpayer Advocate Service, including their phone number."
      }}
    }}

    Here is the text to analyze:
    ---
    {text}
    ---
    """
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    try:
        response = requests.post(GEMINI_API_URL, json=payload, timeout=45)
        response.raise_for_status()
        result = response.json()
        
        # FIX: More robustly parse the Gemini API response to avoid KeyErrors.
        if 'candidates' in result and result['candidates'] and 'content' in result['candidates'][0] and 'parts' in result['candidates'][0]['content'] and result['candidates'][0]['content']['parts']:
            summary_json_string = result['candidates'][0]['content']['parts'][0]['text']
            if summary_json_string.strip().startswith("```json"):
                summary_json_string = summary_json_string.strip()[7:-3]
            return summary_json_string
        else:
            print("GEMINI API ERROR: Unexpected response structure.")
            return None

    except requests.exceptions.RequestException as e:
        print(f"GEMINI API REQUEST FAILED: {e}")
        return None
    except Exception as e:
        print(f"GEMINI API UNKNOWN ERROR: {e}")
        return None

@app.route('/register', methods=['POST'])
def register_user():
    data = request.get_json()
    required_fields = ['firstName', 'lastName', 'email', 'password', 'dob', 'mobileNumber']
    if not data or not all(k in data for k in required_fields):
        return jsonify({"success": False, "message": "Missing required fields."}), 400

    password_hash = generate_password_hash(data['password'])
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database connection error."}), 500

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE email = %s;", (data['email'],))
            if cur.fetchone():
                return jsonify({"success": False, "message": "This email address is already in use."}), 409
            
            sql = """
                INSERT INTO users (first_name, last_name, email, password_hash, dob, mobile_number) 
                VALUES (%s, %s, %s, %s, %s, %s) 
                RETURNING id, first_name, email;
            """
            cur.execute(sql, (data['firstName'], data['lastName'], data['email'], password_hash, data['dob'], data['mobileNumber']))
            new_user = cur.fetchone()
            conn.commit()
            return jsonify({"success": True, "user": new_user}), 201
    except psycopg2.Error as e:
        print(f"REGISTRATION DB ERROR: {e}")
        return jsonify({"success": False, "message": "An internal error occurred."}), 500
    finally:
        if conn:
            conn.close()

@app.route('/login', methods=['POST'])
def login_user():
    data = request.get_json()
    if not data or not all(k in data for k in ['email', 'password']):
        return jsonify({"success": False, "message": "Missing email or password."}), 400
    
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database connection error."}), 500

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE email = %s;", (data['email'],))
            user = cur.fetchone()
            if user and check_password_hash(user['password_hash'], data['password']):
                user_data = {"id": user['id'], "firstName": user['first_name'], "email": user['email']}
                return jsonify({"success": True, "user": user_data}), 200
            else:
                return jsonify({"success": False, "message": "Invalid email or password."}), 401
    except psycopg2.Error as e:
        print(f"LOGIN DB ERROR: {e}")
        return jsonify({"success": False, "message": "An internal error occurred."}), 500
    finally:
        if conn:
            conn.close()

@app.route('/summarize', methods=['POST'])
def summarize_notice():
    if 'notice_pdf' not in request.files:
        return jsonify({"success": False, "message": "No PDF file provided."}), 400
    
    file = request.files['notice_pdf']
    pdf_bytes = file.read()
    raw_text = extract_text_from_pdf(pdf_bytes)
    if not raw_text:
        return jsonify({"success": False, "message": "Could not read text from PDF."}), 500

    summary_json = call_gemini_api(raw_text)
    if not summary_json:
        return jsonify({"success": False, "message": "Failed to get summary from AI."}), 500
        
    try:
        summary_data = json.loads(summary_json)
        return jsonify({"success": True, "summary": summary_data}), 200
    except json.JSONDecodeError:
        print(f"AI returned invalid JSON: {summary_json}")
        return jsonify({"success": False, "message": "AI returned an invalid format."}), 500

# This block ensures the database table is ready when the app starts.
with app.app_context():
    initialize_database()

if __name__ == '__main__':
    # Render uses the PORT environment variable to bind the server.
    port = int(os.environ.get('PORT', 10000))
    # debug=False is important for production. Host '0.0.0.0' makes it accessible.
    app.run(debug=False, host='0.0.0.0', port=port)
```react
