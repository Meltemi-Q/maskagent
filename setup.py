from setuptools import find_packages, setup


setup(
    name="maskagent",
    version="0.3.0",
    description="Local LLM-driven mission orchestration CLI with persistent state, worker/validator loop, and model adapters.",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    python_requires=">=3.9",
    package_dir={"": "src"},
    packages=find_packages("src"),
    entry_points={
        "console_scripts": [
            "mission=mission_runtime.cli:main",
            "missionctl=mission_runtime.cli:main",
            "maskagent=mission_runtime.cli:main",
        ]
    },
)
