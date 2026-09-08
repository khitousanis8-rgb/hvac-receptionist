"""LiveKit worker entrypoint for browser-audio development sessions."""

from __future__ import annotations

import json
import structlog
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobExecutorType, cli, inference
from livekit.plugins import openai

from app.agent.prompts import receptionist_instructions
from app.agent.tools import build_receptionist_tools
from app.call_tracking import end_call, start_call, summarize_session
from app.config import Settings, get_settings
from app.logging import configure_logging

logger = structlog.get_logger(__name__)
# Crucial memory optimization: prod_default spawns 12 idle processes (~1.8GB RAM).
# By setting num_idle_processes=0 and THREAD executor, memory stays ~150MB, well below 512MB.
server = AgentServer(
    num_idle_processes=0,
    job_executor_type=JobExecutorType.THREAD,
)


class HVACReceptionist(Agent):
    """Voice receptionist with real booking and lookup tools."""

    def __init__(self, settings: Settings) -> None:
        super().__init__(
            instructions=receptionist_instructions(settings),
            tools=build_receptionist_tools(settings),
        )


def build_agent_session(settings: Settings) -> AgentSession[None]:
    """Configure the LLM through LiveKit's OpenAI-compatible plugin (Groq by default)."""
    if not settings.configured_for_agent or settings.llm_api_key is None:
        raise RuntimeError(
            "Agent credentials are incomplete. Set LIVEKIT_URL, LIVEKIT_API_KEY, "
            "LIVEKIT_API_SECRET, and LLM_API_KEY before starting the worker."
        )

    api_key = settings.llm_api_key.get_secret_value()
    base_url = str(settings.llm_base_url)

    return AgentSession(
        # Speech-to-text: LiveKit Cloud streaming STT (Deepgram Nova-3) — transcribes
        # while the caller speaks, removing the batch-transcription delay.
        stt=inference.STT("deepgram/nova-3"),
        llm=openai.LLM(
            model=settings.llm_model,
            api_key=api_key,
            base_url=base_url,
            # Skip most hidden reasoning tokens for faster first response.
            reasoning_effort="low",
        ),
        # Text-to-speech: LiveKit Cloud inference (Cartesia Sonic-3).
        tts=inference.TTS(
            "cartesia/sonic-3",
            voice=settings.tts_voice,
        ),
        # Cloud-native turn handling:
        # - Uses LiveKit Cloud TurnDetector & VAD (0% local CPU on Render free tier).
        # - Disables automatic acoustic interruption & discards mic audio while agent speaks:
        #   Prevents speaker feedback loops, audio packet buffer underruns, and speech cuts.
        # - Enables preemptive generation so responses start streaming immediately (sub-second latency).
        turn_handling={
            "interruption": {
                "enabled": False,
                "discard_audio_if_uninterruptible": True,
            },
            "preemptive_generation": {
                "enabled": True,
            },
        },
    )


def load_environment() -> None:
    """Load the project `.env` into the process environment.

    LiveKit's worker reads LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
    from the process environment. Called at worker startup only, so tests
    stay hermetic.
    """
    load_dotenv()


@server.rtc_session(agent_name="hvac-receptionist")
async def receptionist_session(ctx: JobContext) -> None:
    """Join a LiveKit room and begin one receptionist session."""
    settings = get_settings()
    configure_logging(settings.log_level)
    ctx.log_context_fields = {"room": ctx.room.name}
    call_id = start_call(ctx.room.name)
    session = build_agent_session(settings)

    # Listen for explicit user interruption signal from the frontend
    @ctx.room.on("data_received")
    def on_data_received(data_packet: rtc.DataPacket) -> None:
        try:
            payload = json.loads(data_packet.data.decode("utf-8"))
            if payload.get("action") == "interrupt":
                logger.info("manual_interruption_requested", room=ctx.room.name)
                session.interrupt(force=True)
        except Exception as e:
            logger.warning("data_packet_processing_failed", error=str(e))

    await session.start(agent=HVACReceptionist(settings), room=ctx.room)
    await ctx.connect()
    logger.info("agent_session_started", room=ctx.room.name, call_id=call_id)
    session.generate_reply(
        instructions=(
            f"Greet the caller warmly as the receptionist for "
            f"{settings.business_company_name} and ask how you can assist them today."
        )
    )

    async def finalize_call_record() -> None:
        """Save the transcript summary and outcome when the session ends."""
        outcome, summary = summarize_session(list(session.history.items))
        end_call(call_id, outcome, summary)
        logger.info("call_record_finalized", call_id=call_id, outcome=outcome)

    ctx.add_shutdown_callback(finalize_call_record)


if __name__ == "__main__":
    load_environment()
    cli.run_app(server)
