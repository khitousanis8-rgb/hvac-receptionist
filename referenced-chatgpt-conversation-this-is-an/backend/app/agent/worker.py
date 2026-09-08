"""LiveKit worker entrypoint for browser-audio development sessions."""

from __future__ import annotations

import structlog
from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobExecutorType, cli, inference
from livekit.plugins import openai, silero

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
        # Speech-to-text: LiveKit Cloud streaming STT (Deepgram) — transcribes
        # while the caller speaks, removing the batch-transcription delay.
        stt=inference.STT("deepgram/nova-3"),
        llm=openai.LLM(
            model=settings.llm_model,
            api_key=api_key,
            base_url=base_url,
            # Skip most hidden reasoning tokens for faster first response.
            reasoning_effort="low",
        ),
        # Text-to-speech: LiveKit Cloud inference (Cartesia Sonic).
        # Calibrated volume (0.75) provides -4dB to -6dB headroom, preventing
        # raw 16-bit integer clipping (+-32767) that causes harsh static and noise bursts.
        tts=inference.TTS(
            "cartesia/sonic-3",
            voice=settings.tts_voice,
            extra_kwargs={"volume": settings.tts_volume},
        ),
        # Robust voice-activity detection:
        # min_speech_duration=0.25 ignores room clicks, transient echo, and initial speaker bleed.
        # activation_threshold=0.65 requires confident user speech so speaker playback isn't treated as user talk.
        vad=silero.VAD.load(
            min_speech_duration=0.25,
            activation_threshold=0.65,
        ),
        # Stable turn handling:
        # - endpointing min_delay 0.5s prevents cutting off callers prematurely
        # - interruption min_duration 1.0s requires sustained intentional caller speech, preventing
        #   the agent from interrupting itself on laptop speaker acoustic echo leak
        turn_handling={
            "turn_detection": "vad",
            "endpointing": {
                "mode": "fixed",
                "min_delay": 0.5,
                "max_delay": 2.5,
            },
            "interruption": {
                "enabled": True,
                "min_duration": 1.0,
                "resume_false_interruption": False,
            },
            "preemptive_generation": {
                "enabled": False,
            },
        },
        # Ignore caller mic audio during first 5 seconds of agent speech to prevent speaker feedback loop
        aec_warmup_duration=5.0,
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
