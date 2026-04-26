import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import anthropic

app = FastAPI()

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

STAFF_SYSTEM_PROMPT = """You are a professional customer service translator.
Translate the given Japanese text into natural, polite English as a customer-facing staff member would say it.
Use professional hospitality language suitable for service industry (hotel, restaurant, retail, etc.).
Output ONLY the translated English text, nothing else."""

CUSTOMER_SYSTEM_PROMPT = """You are a professional customer service translator.
Translate the given English text into natural Japanese, written from the perspective of a customer asking a question or making a request to staff.
Use polite customer Japanese (〜ですか、〜をお願いしたいのですが、etc.).
Output ONLY the translated Japanese text, nothing else."""


class TranslateRequest(BaseModel):
    text: str
    mode: str  # "staff" or "customer"


@app.post("/api/translate")
async def translate(req: TranslateRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="テキストを入力してください")

    if req.mode == "staff":
        system = STAFF_SYSTEM_PROMPT
        user_message = f"Translate this Japanese to English:\n{req.text}"
    elif req.mode == "customer":
        system = CUSTOMER_SYSTEM_PROMPT
        user_message = f"Translate this English to Japanese:\n{req.text}"
    else:
        raise HTTPException(status_code=400, detail="Invalid mode")

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=system,
        messages=[{"role": "user", "content": user_message}],
    )

    return {"result": message.content[0].text}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
