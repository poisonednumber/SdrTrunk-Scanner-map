# persistent_transcribe.py
# Enhanced with OpenAI-style prompting support for better scanner audio transcription
import sys
import io
import torch
import warnings
import os
import json
import logging
import base64
import numpy as np
from pydub import AudioSegment
from dotenv import load_dotenv

# Import tone detection module
try:
    from tone_detect import ToneDetector
    TONE_DETECTION_AVAILABLE = True
    logger_temp = logging.getLogger(__name__)
    logger_temp.info("✓ Tone detection module loaded successfully")
except ImportError as e:
    TONE_DETECTION_AVAILABLE = False
    print(f"WARNING: Tone detection not available: {e}", file=sys.stderr)

# Suppress specific CUDA compatibility warnings for newer GPUs
warnings.filterwarnings("ignore", message=".*CUDA capability.*not compatible.*")
warnings.filterwarnings("ignore", message=".*with CUDA capability.*")

# Load environment variables from .env
load_dotenv()

# Get environment variables - strict loading, no defaults
WHISPER_MODEL = os.getenv('WHISPER_MODEL')
TRANSCRIPTION_DEVICE = os.getenv('TRANSCRIPTION_DEVICE')
OPENAI_TRANSCRIPTION_PROMPT = os.getenv('OPENAI_TRANSCRIPTION_PROMPT')

# Validate required environment variables
required_vars = ['WHISPER_MODEL', 'TRANSCRIPTION_DEVICE']
missing_vars = [var for var in required_vars if os.getenv(var) is None]

if missing_vars:
    error_msg = f"FATAL ERROR: Missing required environment variables: {', '.join(missing_vars)}"
    print(error_msg, file=sys.stderr)
    print("Please check your .env file and ensure these variables are set:", file=sys.stderr)
    for var in missing_vars:
        print(f"  {var}=<value>", file=sys.stderr)
    sys.exit(1)

# Startup validation function
def validate_startup_environment():
    """Validate that all required dependencies are available before starting"""
    try:
        print("Validating Python environment...", file=sys.stderr)
        
        # Check Python version
        python_version = sys.version_info
        if python_version.major < 3 or (python_version.major == 3 and python_version.minor < 8):
            print(f"ERROR: Python 3.8+ required, found {python_version.major}.{python_version.minor}", file=sys.stderr)
            return False
        
        # Check critical imports
        try:
            import torch
            print(f"✓ PyTorch {torch.__version__} available", file=sys.stderr)
        except ImportError as e:
            print(f"ERROR: PyTorch not available: {e}", file=sys.stderr)
            return False
            
        try:
            from faster_whisper import WhisperModel
            print("✓ faster-whisper available", file=sys.stderr)
        except ImportError as e:
            print(f"ERROR: faster-whisper not available: {e}", file=sys.stderr)
            return False
            
        try:
            from pydub import AudioSegment
            print("✓ pydub available", file=sys.stderr)
        except ImportError as e:
            print(f"ERROR: pydub not available: {e}", file=sys.stderr)
            return False
            
        # Check device availability
        if TRANSCRIPTION_DEVICE == 'cuda':
            if not torch.cuda.is_available():
                print("ERROR: CUDA requested but not available", file=sys.stderr)
                print("Available devices:", file=sys.stderr)
                print(f"  CPU: Available", file=sys.stderr)
                print(f"  CUDA: {torch.cuda.is_available()}", file=sys.stderr)
                if hasattr(torch.backends, 'mps'):
                    print(f"  MPS: {torch.backends.mps.is_available()}", file=sys.stderr)
                return False
            else:
                print(f"✓ CUDA available: {torch.cuda.get_device_name()}", file=sys.stderr)
        
        # Log prompt configuration if available
        if OPENAI_TRANSCRIPTION_PROMPT:
            print("✓ Custom transcription prompt configured", file=sys.stderr)
        
        print("✓ Environment validation passed", file=sys.stderr)
        return True
        
    except Exception as e:
        print(f"ERROR during environment validation: {e}", file=sys.stderr)
        return False

# Run startup validation
if not validate_startup_environment():
    print("FATAL: Environment validation failed", file=sys.stderr)
    sys.exit(1)

# Configure logging to send INFO and above to stderr
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stderr)  # Send INFO and above to stderr
    ]
)

logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore")

# Import faster_whisper here
try:
    from faster_whisper import WhisperModel
except ImportError:
    error_msg = "faster_whisper not installed. Run: pip install faster-whisper"
    print(error_msg, file=sys.stderr)
    sys.exit(1)

# Check device availability
device = TRANSCRIPTION_DEVICE
# Check for MPS availability on macOS ARM
if device == "mps" and not torch.backends.mps.is_available():
    logger.warning("MPS requested but not available. Checking for CUDA...")
    if torch.cuda.is_available():
        logger.warning("CUDA is available, falling back to CUDA.")
        device = "cuda"
    else:
        logger.warning("CUDA not available, falling back to CPU.")
        device = "cpu"
elif device == "cuda" and not torch.cuda.is_available():
    logger.warning("CUDA requested but not available. Falling back to CPU.")
    device = "cpu"

logger.info(f"Using device: {device}")

# Determine computation type
# Use float32 for MPS, float16 for CUDA, int8 for CPU
if device == "mps":
    compute_type = "float32"
    logger.info("Using float32 compute type for MPS device.")
elif device == "cuda":
    compute_type = "float16"
    logger.info("Using float16 compute type for CUDA device.")
else:
    compute_type = "int8"
    logger.info("Using int8 compute type for CPU device.")

# Load the Faster Whisper model with optimizations for high-volume systems
try:
    model = WhisperModel(
        WHISPER_MODEL,
        device=device,
        compute_type=compute_type,
        download_root="./models",  # Cache models locally
        num_workers=1,  # Single worker to avoid memory issues under high load
        cpu_threads=0  # Use default CPU threads (auto-detect)
    )
    logger.info(f"Loaded model: {WHISPER_MODEL} on {device} with compute_type: {compute_type}")
    
    # Log prompt configuration if available
    if OPENAI_TRANSCRIPTION_PROMPT:
        logger.info("Custom transcription prompt configured for scanner audio context")
except Exception as e:
    error_msg = f"Error loading model: {str(e)}"
    print(error_msg, file=sys.stderr)
    sys.exit(1)

# Initialize tone detector if available
tone_detector = None
if TONE_DETECTION_AVAILABLE:
    try:
        # Get tone detection configuration from environment or use defaults
        tone_config = {
            'tone_a_min_length': float(os.getenv('TWO_TONE_MIN_TONE_LENGTH', '0.85')),
            'tone_b_min_length': float(os.getenv('TWO_TONE_MAX_TONE_LENGTH', '5.0')),
            'matching_threshold': float(os.getenv('TWO_TONE_DETECTION_THRESHOLD', '2.5')),
            'fe_freq_band': os.getenv('TWO_TONE_FREQUENCY_BAND', '200,3000'),
            'two_tone_bw_hz': int(os.getenv('TWO_TONE_BANDWIDTH_HZ', '25')),
            'two_tone_min_pair_separation_hz': int(os.getenv('TWO_TONE_MIN_PAIR_SEPARATION_HZ', '40')),
            'time_resolution_ms': int(os.getenv('TWO_TONE_TIME_RESOLUTION_MS', '50'))
        }
        tone_detector = ToneDetector(tone_config)
        logger.info("✓ Tone detector initialized with configuration")
    except Exception as e:
        logger.warning(f"Failed to initialize tone detector: {e}")
        tone_detector = None

# Signal that the model is loaded and ready
print(json.dumps({"ready": True}))
sys.stdout.flush()

# Track last heartbeat time
import time
last_heartbeat = time.time()

# Main loop to process commands
while True:
    try:
        # Send periodic heartbeat to show process is alive during quiet periods
        current_time = time.time()
        if current_time - last_heartbeat > 300:  # 5 minutes
            print(json.dumps({"heartbeat": True, "timestamp": current_time}))
            sys.stdout.flush()
            last_heartbeat = current_time
        
        # Read command from stdin with timeout handling
        line = sys.stdin.readline().strip()
        if not line:
            continue

        command = json.loads(line)
        request_id = command.get('id')

        if not request_id:
            logger.error(f"Command missing 'id': {line}")
            continue
        
        # Log that we're starting to process this request
        logger.info(f"Processing transcription request ID: {request_id}")

        # Determine input type: path or base64 data
        audio_input = None
        input_type = None
        error_detail = None

        if command.get('command') == 'transcribe':
            if 'path' in command:
                audio_file_path = command['path']
                if not os.path.isfile(audio_file_path):
                    error_detail = f"Audio file does not exist: {audio_file_path}"
                else:
                    audio_input = audio_file_path
                    input_type = 'path'
            elif 'audio_data_base64' in command:
                try:
                    base64_data = command['audio_data_base64']
                    audio_bytes = base64.b64decode(base64_data)
                    if not audio_bytes:
                        error_detail = "Decoded audio data is empty."
                    else:
                        # Load audio from bytes using pydub
                        audio_segment = AudioSegment.from_file(io.BytesIO(audio_bytes))
                        # Convert to mono and set frame rate for Whisper (16kHz)
                        audio_segment = audio_segment.set_frame_rate(16000).set_channels(1)
                        # Convert to numpy array of floats
                        samples = np.array(audio_segment.get_array_of_samples()).astype(np.float32) / 32768.0
                        audio_input = samples
                        input_type = 'buffer'
                except base64.binascii.Error:
                    error_detail = "Invalid Base64 data received."
                except Exception as e:
                    error_detail = f"Error processing audio buffer: {str(e)}"
            else:
                error_detail = "Invalid command format: missing 'path' or 'audio_data_base64'."
        elif command.get('command') == 'detect_tones':
            # Handle tone detection command
            if not TONE_DETECTION_AVAILABLE or not tone_detector:
                error_detail = "Tone detection is not available. Please install icad-tone-detection."
            elif 'path' in command:
                audio_file_path = command['path']
                if not os.path.isfile(audio_file_path):
                    error_detail = f"Audio file does not exist: {audio_file_path}"
                else:
                    # Process tone detection immediately and return result
                    logger.info(f"Processing tone detection request ID: {request_id} for file: {audio_file_path}")
                    try:
                        detection_result = tone_detector.detect_tones_in_file(audio_file_path)
                        detected_tones = tone_detector.get_detected_tones(detection_result)
                        
                        response = {
                            "id": request_id,
                            "has_two_tone": detection_result.get('has_two_tone', False),
                            "detected_tones": detected_tones,
                            "file_path": audio_file_path
                        }
                        
                        if 'error' in detection_result:
                            response['error'] = detection_result['error']
                        
                        logger.info(f"Tone detection completed for ID {request_id}: {response['has_two_tone']}")
                        print(json.dumps(response))
                        sys.stdout.flush()
                        continue  # Skip the transcription processing section
                        
                    except Exception as e:
                        error_detail = f"Error during tone detection: {str(e)}"
            else:
                error_detail = "Tone detection requires 'path' parameter."
        else:
             error_detail = f"Invalid command: {command.get('command')}"

        if error_detail:
            error_response = {"id": request_id, "error": error_detail}
            print(json.dumps(error_response))
            sys.stdout.flush()
            continue

        # --- Start Transcription ---
        logger.info(f"Starting transcription for ID: {request_id} (type: {input_type})")

        # File integrity check ONLY if input is a path
        if input_type == 'path':
            try:
                import subprocess
                # First check if file exists and is readable
                if not os.path.isfile(audio_input):
                    error_response = {"id": request_id, "error": f"Audio file not found: {audio_input}"}
                    print(json.dumps(error_response))
                    sys.stdout.flush()
                    continue
                    
                # Check file size (basic validation)
                file_size = os.path.getsize(audio_input)
                if file_size < 1000:  # Less than 1KB
                    error_response = {"id": request_id, "error": f"Audio file too small: {file_size} bytes"}
                    print(json.dumps(error_response))
                    sys.stdout.flush()
                    continue
                elif file_size > 100 * 1024 * 1024:  # More than 100MB
                    error_response = {"id": request_id, "error": f"Audio file too large: {file_size} bytes"}
                    print(json.dumps(error_response))
                    sys.stdout.flush()
                    continue
                
                # Quick ffprobe check for file integrity
                result = subprocess.run(
                    ['ffprobe', '-v', 'quiet', '-show_format', audio_input],
                    stderr=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    timeout=15  # Increased timeout
                )
                if result.returncode != 0:
                    error_response = {"id": request_id, "error": f"Corrupt audio file (ffprobe check): {audio_input}"}
                    print(json.dumps(error_response))
                    sys.stdout.flush()
                    continue
            except subprocess.TimeoutExpired:
                logger.warning(f"FFprobe timeout for file: {audio_input}")
                error_response = {"id": request_id, "error": f"File validation timeout: {audio_input}"}
                print(json.dumps(error_response))
                sys.stdout.flush()
                continue
            except Exception as probe_err:
                logger.warning(f"FFprobe check failed for {audio_input}: {str(probe_err)}")
                # Continue with transcription attempt anyway

        # Transcribe the audio (from path or buffer) with English as the specified language
        try:
            # Add memory cleanup before transcription for large buffers
            if input_type == 'buffer':
                import gc
                gc.collect()  # Force garbage collection before processing large audio
            
            # Prepare transcription parameters
            transcription_params = {
                'audio': audio_input,  # Can be path string or numpy array
                'language': 'en',
                'beam_size': 3,  # Reduced from 5 to 3 for faster processing
                'vad_filter': True,
                'vad_parameters': {"min_silence_duration_ms": 750},  # Increased threshold for busy systems
                'word_timestamps': False,  # Disable word timestamps for speed
                'condition_on_previous_text': False  # Disable for better performance
            }
            
            # Add prompt if available (helps with scanner audio context)
            if OPENAI_TRANSCRIPTION_PROMPT:
                transcription_params['initial_prompt'] = OPENAI_TRANSCRIPTION_PROMPT
                logger.info(f"Using custom transcription prompt for ID {request_id}")
                
            # Try with VAD filtering first - optimized for high-volume systems
            segments, info = model.transcribe(**transcription_params)

            segments_text = [segment.text for segment in segments]
            transcription = " ".join(segments_text).strip()

            # If transcription is empty after VAD filtering, try without VAD
            if not transcription:
                logger.info(f"Retrying transcription for ID {request_id} without VAD filter.")
                
                # Retry without VAD but keep other parameters including prompt
                retry_params = transcription_params.copy()
                retry_params['vad_filter'] = False
                
                segments, info = model.transcribe(**retry_params)
                segments_text = [segment.text for segment in segments]
                transcription = " ".join(segments_text).strip()

            logger.info(f"Transcription successful for ID: {request_id} (length: {len(transcription)} chars)")
            success_response = {"id": request_id, "transcription": transcription}
            print(json.dumps(success_response))
            sys.stdout.flush()
            
            # Clean up memory for buffer-based transcriptions
            if input_type == 'buffer':
                del audio_input  # Free the numpy array
                gc.collect()

        except Exception as e:
            error_str = str(e)
            # Detect specific FFmpeg/audio processing errors
            if "[Errno 1094995529]" in error_str or "Invalid data found" in error_str or "corrupt" in error_str.lower():
                 error_response = {"id": request_id, "error": f"Corrupt audio data for ID {request_id}."}
            elif "out of memory" in error_str.lower() or "memory" in error_str.lower():
                 error_response = {"id": request_id, "error": f"Out of memory during transcription for ID {request_id}."}
            else:
                 error_response = {"id": request_id, "error": f"Error during transcription for ID {request_id}: {error_str}"}
            logger.error(f"Transcription failed for ID {request_id}: {error_response['error']}")
            print(json.dumps(error_response))
            sys.stdout.flush()
            
            # Clean up memory on error for buffer-based transcriptions
            if input_type == 'buffer' and 'audio_input' in locals():
                try:
                    del audio_input
                    import gc
                    gc.collect()
                except:
                    pass
            # --- End Transcription ---

    except json.JSONDecodeError as json_err:
        logger.error(f"Failed to decode JSON command: {line} - Error: {json_err}")
        continue # Skip this invalid command
    except Exception as e:
        # Catch broader exceptions in the loop to prevent crashing
        logger.error(f"Unexpected error in main loop: {str(e)}", exc_info=True)
        # Optionally send an error back if we can identify the ID
        if 'request_id' in locals() and request_id:
             error_response = {"id": request_id, "error": f"Unexpected server error: {str(e)}"}
             try:
                 print(json.dumps(error_response))
                 sys.stdout.flush()
             except Exception:
                 pass # Ignore errors trying to report errors
        continue